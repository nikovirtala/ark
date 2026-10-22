import fc from "fast-check";
import type { KindSchema } from "../envelope/kind.js";
import type { EventEnvelope, JsonSchema } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { InvalidArgumentError } from "../errors.js";
import { bodyFileName, eventFileName } from "../identity/files.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath, type LogLayout } from "../identity/layout.js";
import { arbEnvelope, arbSlug, arbSubjectId, arbUnknownFields } from "./arbitraries.js";

export interface LogFixtureSubjectInput {
  readonly id: string;
  readonly slug?: string;
  /** The body file's content; omitted for a subject without a body. */
  readonly body?: string;
  readonly events: readonly EventEnvelope[];
}

export interface LogFixture {
  readonly kind: KindSchema;
  readonly layout: LogLayout;
  /** Repo-relative path → content, exactly what `logFixtureFiles` produced. */
  readonly files: Readonly<Record<string, string>>;
  readonly subjects: readonly {
    readonly id: string;
    /** `null` when the kind has no bodies or the subject has none. */
    readonly bodyPath: string | null;
    /** Has at least one event of the kind's `freezeOn` type. */
    readonly frozen: boolean;
    /** In file-name order. */
    readonly events: readonly { readonly path: string; readonly event: EventEnvelope }[];
  }[];
}

const encoder = new TextEncoder();
const arbRandomHash = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => Buffer.from(b).toString("hex"));

/** The path → content map of a log: each event serialized at its path, plus the body files. */
export function logFixtureFiles(o: {
  readonly layout: LogLayout;
  readonly subjects: readonly LogFixtureSubjectInput[];
}): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (path: string, content: string) => {
    if (Object.hasOwn(files, path))
      throw new InvalidArgumentError(`duplicate fixture path ${path}`);
    files[path] = content;
  };
  const { layout } = o;
  for (const s of o.subjects) {
    if (s.body !== undefined) {
      if (layout.bodies === null) {
        throw new InvalidArgumentError(`subject ${s.id} has a body but the layout has no bodies`);
      }
      add(`${layout.root}/${layout.bodies}/${bodyFileName(s.id, s.slug ?? "")}`, s.body);
    }
    for (const e of s.events) add(eventPath(layout, e), serializeEvent(e));
  }
  return files;
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A value for one property schema: `const`, `enum` and the basic `type`s; anything else is `null`. */
function arbValueFor(schema: unknown): fc.Arbitrary<unknown> {
  if (!isMapping(schema)) return fc.constant(null);
  if ("const" in schema) return fc.constant(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return fc.constantFrom(...schema.enum);
  switch (schema.type) {
    case "string": {
      const min = typeof schema.minLength === "number" ? schema.minLength : 0;
      return fc.string({ minLength: Math.max(1, min), maxLength: Math.max(20, min) });
    }
    case "integer":
    case "number":
      return fc.integer();
    case "boolean":
      return fc.boolean();
    case "array":
      return fc.constant([]);
    case "object":
      return fc.constant({});
    default:
      return fc.constant(null);
  }
}

/**
 * Data for a data schema: its required properties (simple constraints only) plus unknown fields
 * that avoid every declared property.
 */
function arbDataFor(
  schema: JsonSchema | undefined,
  hashField: string | null,
): fc.Arbitrary<Record<string, unknown>> {
  const props = isMapping(schema?.properties) ? schema.properties : {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((k): k is string => typeof k === "string" && k !== hashField)
    : [];
  const reserved = [...Object.keys(props), ...required, ...(hashField === null ? [] : [hashField])];
  return fc
    .tuple(fc.tuple(...required.map((k) => arbValueFor(props[k]))), arbUnknownFields(reserved))
    .map(([values, extra]) => ({
      ...Object.fromEntries(required.map((k, i) => [k, values[i]])),
      ...extra,
    }));
}

function freezePolicy(kind: KindSchema): { freezeOn: string; hashField: string } | null {
  return typeof kind.body === "object"
    ? { freezeOn: kind.body.freezeOn, hashField: kind.body.hashField ?? "body_sha256" }
    : null;
}

/** `hash` is written into every freeze-type event; `null` draws a random one. */
function arbEvents(
  kind: KindSchema,
  subject: string,
  types: readonly string[],
  length: { readonly minLength: number; readonly maxLength: number },
  hash: string | null,
): fc.Arbitrary<EventEnvelope[]> {
  if (types.length === 0) throw new InvalidArgumentError(`kind ${kind.name} has no usable types`);
  const freeze = freezePolicy(kind);
  const arbHash = hash === null ? arbRandomHash : fc.constant<string>(hash);
  const event = fc
    .constantFrom(...types)
    .chain((type) => arbEnvelope({ kind, subject, type }))
    .chain((e) => {
      const isFreeze = freeze !== null && e.type === freeze.freezeOn;
      const schema = kind.schemas[e.schema]?.events[e.type]?.data;
      return fc.tuple(arbDataFor(schema, isFreeze ? freeze.hashField : null), arbHash).map(
        ([data, h]): EventEnvelope => ({
          ...e,
          data: isFreeze ? { ...data, [freeze.hashField]: h } : data,
        }),
      );
    });
  return fc
    .array(event, length)
    .map((events) =>
      events
        .map((e) => ({ e, name: eventFileName(e) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ e }) => e),
    )
    .filter((events) => {
      const unique = (keys: string[]) => new Set(keys).size === keys.length;
      return unique(events.map(eventFileName)) && unique(events.map((e) => e.id));
    });
}

const allTypes = (kind: KindSchema) => [
  ...new Set(Object.values(kind.schemas).flatMap((v) => Object.keys(v.events))),
];

/**
 * Valid events of one subject in file-name order: envelope and simple data constraints only, no
 * state machine (that needs step 3's fold). Freeze-type events carry a random hash.
 */
export function arbEventSequence(o: {
  readonly kind: KindSchema;
  readonly subject?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
}): fc.Arbitrary<EventEnvelope[]> {
  const length = { minLength: o.minLength ?? 1, maxLength: o.maxLength ?? 5 };
  return (o.subject === undefined ? arbSubjectId() : fc.constant(o.subject)).chain((subject) =>
    arbEvents(o.kind, subject, allTypes(o.kind), length, null),
  );
}

/**
 * Valid logs: unique subject and event ids, correct file names, and body hashes that match on
 * every freeze-type event. Only subjects with a body get freeze-type events.
 */
export function arbLogFixture(o: {
  readonly kind: KindSchema;
  readonly layout: LogLayout;
  readonly maxSubjects?: number;
}): fc.Arbitrary<LogFixture> {
  const { kind, layout } = o;
  if ((kind.body === "none") !== (layout.bodies === null)) {
    throw new InvalidArgumentError(
      `kind ${kind.name} body policy and layout bodies must both be set or both be absent`,
    );
  }
  const freeze = freezePolicy(kind);
  const types = allTypes(kind);
  const unfrozenTypes = types.filter((t) => t !== freeze?.freezeOn);
  const subject = (id: string): fc.Arbitrary<LogFixtureSubjectInput> =>
    fc
      .record({
        slug: arbSlug(),
        body:
          kind.body === "none"
            ? fc.constant(undefined)
            : fc.option(fc.string({ unit: "grapheme", maxLength: 80 }), { nil: undefined }),
      })
      .chain(({ slug, body }) =>
        arbEvents(
          kind,
          id,
          body === undefined ? unfrozenTypes : types,
          { minLength: 1, maxLength: 4 },
          body === undefined ? null : bodySha256(encoder.encode(body)),
        ).map((events) => ({ id, slug, ...(body === undefined ? {} : { body }), events })),
      );
  return fc
    .uniqueArray(arbSubjectId(), { maxLength: o.maxSubjects ?? 4 })
    .chain((ids) => fc.tuple(...ids.map(subject)))
    .filter((inputs) => {
      const ids = inputs.flatMap((s) => s.events.map((e) => e.id));
      return new Set(ids).size === ids.length;
    })
    .map((inputs): LogFixture => {
      const files = logFixtureFiles({ layout, subjects: inputs });
      return {
        kind,
        layout,
        files,
        subjects: inputs.map((s) => ({
          id: s.id,
          bodyPath:
            s.body === undefined || layout.bodies === null
              ? null
              : `${layout.root}/${layout.bodies}/${bodyFileName(s.id, s.slug ?? "")}`,
          frozen: freeze !== null && s.events.some((e) => e.type === freeze.freezeOn),
          events: s.events.map((event) => ({ path: eventPath(layout, event), event })),
        })),
      };
    });
}
