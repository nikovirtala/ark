import { createRequire } from "node:module";
import type { Ajv2020, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
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
  /** Default `"optional"`. `"required"`: events of this type need a non-blank `reason`. */
  readonly reason?: "required" | "optional";
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
  /**
   * Validates a parsed event document in the order of design §4.3.2. Compiles the event type's
   * data schema on first use; throws `KindDefinitionError` when it doesn't compile.
   */
  validate(doc: unknown, ctx: { readonly file: string | null }): ValidationResult;
  /** Compiles every data schema now; throws `KindDefinitionError` for the first that fails. */
  compileAll(): void;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_FINDINGS_PER_FILE = 10;

// ajv takes ~50ms to import and its compiler most of a CLI's startup, so it loads on the first
// validation: commands that validate no event (`--help`, most git hooks) never pay for it.
const requireCjs = createRequire(import.meta.url);

function newAjv(): Ajv2020 {
  const { Ajv2020 } = requireCjs("ajv/dist/2020.js") as typeof import("ajv/dist/2020.js");
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

/**
 * Steps 1–3 of the validation order (design §4.3.2): a mapping, a known envelope version and the
 * envelope schema. `null` when the envelope is valid; the kind's own checks come after.
 */
export function envelopeFailure(
  doc: unknown,
  file: string | null,
): { readonly findings: readonly Finding[]; readonly versionKnown: boolean } | null {
  const one = (rule: string, message: string) => [
    finding({ severity: "error", rule, message, file }),
  ];
  if (!isMapping(doc)) {
    return { findings: one("event/not-a-mapping", "event is not a mapping"), versionKnown: true };
  }
  if (typeof doc.envelope === "string" && doc.envelope !== ENVELOPE_VERSION) {
    return {
      findings: one(
        "envelope/unknown-version",
        `unknown envelope version ${JSON.stringify(doc.envelope)}; upgrade the tool to read this event`,
      ),
      versionKnown: false,
    };
  }
  const errors = envelopeErrors(doc);
  if (errors !== null) {
    return { findings: schemaFindings(errors, "envelope/schema", file, ""), versionKnown: true };
  }
  if (!isAt(doc.at)) {
    return {
      findings: one("envelope/schema", "/at: not a valid UTC timestamp"),
      versionKnown: true,
    };
  }
  return null;
}

const compiled = new WeakMap<KindSchema, CompiledKind>();

/**
 * Checks a kind's names and data schemas' top level once per kind object; throws
 * `KindDefinitionError`. Each data schema is compiled on its type's first validation (or by
 * `compileAll`), so a schema ajv rejects throws `KindDefinitionError` then.
 */
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
  let ajv: Ajv2020 | undefined;
  const validators = new Map<string, Map<string, () => ValidateFunction>>();
  const reasonRequired = new Map<string, Set<string>>();
  for (const [key, version] of Object.entries(kind.schemas)) {
    if (!schemaKey.test(key)) {
      throw fail(`kind ${name}: schema key ${JSON.stringify(key)} must be "${name}/v<n>"`);
    }
    const types = new Map<string, () => ValidateFunction>();
    const required = new Set<string>();
    for (const [type, { data, reason }] of Object.entries(version.events)) {
      if (reason === "required") required.add(type);
      const where = `kind ${name}: ${key} event type ${JSON.stringify(type)}`;
      if (type.length > 64 || !NAME.test(type)) throw fail(`${where} is not a valid event type`);
      if (!isMapping(data) || (data.type !== undefined && data.type !== "object")) {
        throw fail(`${where}: data schema must describe an object`);
      }
      if (data.additionalProperties === false || data.unevaluatedProperties === false) {
        throw fail(`${where}: data schema must allow unknown fields at the top level`);
      }
      let validator: ValidateFunction | undefined;
      types.set(type, () => {
        if (validator !== undefined) return validator;
        try {
          ajv ??= newAjv();
          validator = ajv.compile(data);
          return validator;
        } catch (e) {
          throw fail(`${where}: ${e instanceof Error ? e.message : String(e)}`, e);
        }
      });
    }
    validators.set(key, types);
    reasonRequired.set(key, required);
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

      const envelope = envelopeFailure(doc, file);
      if (envelope !== null) return failed(envelope.findings, envelope.versionKnown);
      const e = doc as Record<string, unknown>; // a mapping: envelopeFailure checked it
      if (e.kind !== name) {
        return failed(
          one(
            "envelope/kind-mismatch",
            `event kind ${JSON.stringify(e.kind)} does not match the log's kind "${name}"`,
          ),
        );
      }
      const schema = String(e.schema);
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
      const validatorOf = types.get(String(e.type));
      if (validatorOf === undefined) {
        return failed(
          one(
            "envelope/unknown-type",
            `unknown event type ${JSON.stringify(e.type)} in schema "${schema}"`,
          ),
        );
      }
      const validateData = validatorOf();
      if (!validateData(e.data)) {
        return failed(schemaFindings(validateData.errors, "data/schema", file, "/data"));
      }
      const type = String(e.type);
      if (
        reasonRequired.get(schema)?.has(type) === true &&
        (typeof e.reason !== "string" || e.reason.trim() === "")
      ) {
        return failed(one("event/reason-required", `${type} events need a reason`));
      }
      return { ok: true, event: e as unknown as EventEnvelope, findings: [] };
    },
    compileAll() {
      for (const types of validators.values())
        for (const validatorOf of types.values()) validatorOf();
    },
  };
  compiled.set(kind, result);
  return result;
}
