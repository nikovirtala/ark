import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { KindDefinitionError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import { isAt } from "../identity/time.js";
import { envelopeSchema } from "./schema.js";
import type { EventEnvelope, JsonSchema } from "./types.js";
import { ENVELOPE_VERSION } from "./version.js";

/**
 * What a kind does with its body file: none, mutable (left to git), or frozen by the first event
 * of type `freezeOn`, which records the body hash in `data[hashField]` (default `body_sha256`).
 */
export type BodyPolicy =
  | "none"
  | "mutable"
  | { readonly freezeOn: string; readonly hashField?: string };

export interface EventTypeSchema {
  /** JSON Schema (draft 2020-12) of the event's `data`; must stay open at the top level. */
  readonly data: JsonSchema;
}

/** The structural kind plug-in. Step 3's `defineKind` returns an object satisfying it. */
export interface KindSchema {
  /** The envelope `kind`. */
  readonly name: string;
  /** Keyed by `<name>/v<n>`. */
  readonly schemas: Readonly<
    Record<string, { readonly events: Readonly<Record<string, EventTypeSchema>> }>
  >;
  readonly body: BodyPolicy;
}

export type ValidationResult =
  | { readonly ok: true; readonly event: EventEnvelope; readonly findings: readonly [] }
  | {
      readonly ok: false;
      readonly event: null;
      readonly findings: readonly Finding[];
      /** `false` when the envelope or data-schema version is unknown to this reader. */
      readonly versionKnown: boolean;
    };

export interface CompiledKind {
  readonly kind: KindSchema;
  /** Validates a parsed event document in the order of design §4.3.2. */
  validate(doc: unknown, ctx: { readonly file: string | null }): ValidationResult;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_FINDINGS_PER_FILE = 10;

function newAjv(): Ajv2020 {
  return new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    allErrors: true,
    logger: false,
    removeAdditional: false,
    useDefaults: false,
    coerceTypes: false,
  });
}

let envelopeValidator: ValidateFunction | undefined;

/** The envelope schema's errors for `doc`, or `null` when it passes. */
function envelopeErrors(doc: unknown): readonly ErrorObject[] | null {
  envelopeValidator ??= newAjv().compile(envelopeSchema);
  return envelopeValidator(doc) ? null : (envelopeValidator.errors ?? []);
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One finding per ajv error, `<path>: <message>`. A failing `if/then` is reported both as its leaf
 * error and as an `if` summary; the summary is dropped unless nothing else is left.
 */
function schemaFindings(
  errors: readonly ErrorObject[] | null | undefined,
  rule: string,
  file: string | null,
  prefix: string,
): Finding[] {
  const all = errors ?? [];
  const leaf = all.filter((e) => e.keyword !== "if");
  const kept = (leaf.length > 0 ? leaf : all.slice(0, 1)).slice(0, MAX_FINDINGS_PER_FILE);
  if (kept.length === 0) {
    return [finding({ severity: "error", rule, message: `${prefix || "/"}: is invalid`, file })];
  }
  return kept.map((e) => {
    const path = `${prefix}${e.instancePath}`;
    const message = `${path === "" ? "/" : path}: ${e.message ?? "is invalid"}`;
    return finding({ severity: "error", rule, message, file });
  });
}

const compiled = new WeakMap<KindSchema, CompiledKind>();

/** Compiles a kind's data schemas once per kind object; throws `KindDefinitionError`. */
export function compileKind(kind: KindSchema): CompiledKind {
  const cached = compiled.get(kind);
  if (cached !== undefined) return cached;

  const name = String(kind.name);
  const fail = (message: string, cause?: unknown) =>
    new KindDefinitionError(name, message, cause === undefined ? undefined : { cause });
  if (typeof kind.name !== "string" || kind.name.length > 64 || !NAME.test(kind.name)) {
    throw fail(`invalid kind name ${JSON.stringify(kind.name)}`);
  }
  const schemaKey = new RegExp(`^${name}/v[1-9][0-9]*$`);
  const ajv = newAjv();
  const validators = new Map<string, Map<string, ValidateFunction>>();
  for (const [key, version] of Object.entries(kind.schemas)) {
    if (!schemaKey.test(key)) {
      throw fail(`kind ${name}: schema key ${JSON.stringify(key)} must be "${name}/v<n>"`);
    }
    const types = new Map<string, ValidateFunction>();
    for (const [type, { data }] of Object.entries(version.events)) {
      const where = `kind ${name}: ${key} event type ${JSON.stringify(type)}`;
      if (type.length > 64 || !NAME.test(type)) throw fail(`${where} is not a valid event type`);
      if (!isMapping(data) || (data.type !== undefined && data.type !== "object")) {
        throw fail(`${where}: data schema must describe an object`);
      }
      if (data.additionalProperties === false || data.unevaluatedProperties === false) {
        throw fail(`${where}: data schema must allow unknown fields at the top level`);
      }
      try {
        types.set(type, ajv.compile(data));
      } catch (e) {
        throw fail(`${where}: ${e instanceof Error ? e.message : String(e)}`, e);
      }
    }
    validators.set(key, types);
  }
  if (typeof kind.body === "object") {
    const { freezeOn } = kind.body;
    if (![...validators.values()].some((types) => types.has(freezeOn))) {
      throw fail(`kind ${name}: freezeOn type ${JSON.stringify(freezeOn)} is not defined`);
    }
  }

  const result: CompiledKind = {
    kind,
    validate(doc, { file }) {
      const failed = (findings: readonly Finding[], versionKnown = true): ValidationResult => ({
        ok: false,
        event: null,
        findings,
        versionKnown,
      });
      const one = (rule: string, message: string) => [
        finding({ severity: "error", rule, message, file }),
      ];

      if (!isMapping(doc)) return failed(one("event/not-a-mapping", "event is not a mapping"));
      if (typeof doc.envelope === "string" && doc.envelope !== ENVELOPE_VERSION) {
        return failed(
          one(
            "envelope/unknown-version",
            `unknown envelope version ${JSON.stringify(doc.envelope)}; upgrade the tool to read this event`,
          ),
          false,
        );
      }
      const errors = envelopeErrors(doc);
      if (errors !== null) return failed(schemaFindings(errors, "envelope/schema", file, ""));
      if (!isAt(doc.at)) return failed(one("envelope/schema", "/at: not a valid UTC timestamp"));
      if (doc.kind !== name) {
        return failed(
          one(
            "envelope/kind-mismatch",
            `event kind ${JSON.stringify(doc.kind)} does not match the log's kind "${name}"`,
          ),
        );
      }
      const schema = String(doc.schema);
      const types = validators.get(schema);
      if (types === undefined) {
        return failed(
          one(
            "envelope/unknown-schema",
            `unknown schema ${JSON.stringify(schema)}; upgrade the tool to read this event`,
          ),
          false,
        );
      }
      const validateData = types.get(String(doc.type));
      if (validateData === undefined) {
        return failed(
          one(
            "envelope/unknown-type",
            `unknown event type ${JSON.stringify(doc.type)} in schema "${schema}"`,
          ),
        );
      }
      if (!validateData(doc.data)) {
        return failed(schemaFindings(validateData.errors, "data/schema", file, "/data"));
      }
      return { ok: true, event: doc as unknown as EventEnvelope, findings: [] };
    },
  };
  compiled.set(kind, result);
  return result;
}
