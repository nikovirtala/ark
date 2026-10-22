import fc from "fast-check";
import type { KindSchema } from "../envelope/kind.js";
import { ACTOR_KEYS, type Actor, ENVELOPE_KEYS, type EventEnvelope } from "../envelope/types.js";
import { ENVELOPE_VERSION } from "../envelope/version.js";
import { InvalidArgumentError, type JsonValue } from "../errors.js";
import type { EventFileName } from "../identity/files.js";
import { newSubjectId } from "../identity/ids.js";
import { atToStamp, formatAt } from "../identity/time.js";
import { createUlidFactory } from "../identity/ulid.js";

/** Builds an arbitrary once; constructing some (`stringMatching`) is slow. */
function once<T>(build: () => fc.Arbitrary<T>): () => fc.Arbitrary<T> {
  let arb: fc.Arbitrary<T> | undefined;
  return () => {
    arb ??= build();
    return arb;
  };
}

const fill = (bytes: Uint8Array) => (buf: Uint8Array) => buf.set(bytes);

export function arbSubjectId(): fc.Arbitrary<string> {
  return fc.uint8Array({ minLength: 5, maxLength: 5 }).map((b) => newSubjectId(fill(b)));
}

export function arbUlid(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.integer({ min: 0, max: 2 ** 48 - 1 }),
      fc.uint8Array({ minLength: 10, maxLength: 10 }),
    )
    .map(([time, b]) =>
      createUlidFactory({ now: () => time, random: fill(b), monotonic: false })(),
    );
}

/** Event times from 1970 to 9999, second precision. */
export function arbAt(): fc.Arbitrary<string> {
  return fc
    .date({
      min: new Date("1970-01-01T00:00:00Z"),
      max: new Date("9999-12-31T23:59:59Z"),
      noInvalidDate: true,
    })
    .map(formatAt);
}

const eventType = once(() =>
  fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9]{0,11}$/),
      fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { maxLength: 4 }),
    )
    .map(([head, rest]) => [head, ...rest].join("-")),
);

export function arbEventType(): fc.Arbitrary<string> {
  return eventType();
}

export function arbEventFileName(): fc.Arbitrary<EventFileName> {
  return fc.record({
    stamp: arbAt().map(atToStamp),
    rand: arbUlid().map((id) => id.slice(-4).toLowerCase()),
    type: arbEventType(),
  });
}

const slug = once(() =>
  fc.array(fc.stringMatching(/^[a-z0-9]{1,10}$/), { maxLength: 5 }).map((words) => words.join("-")),
);

/** Valid slugs of at most 60 chars, including `""`. */
export function arbSlug(): fc.Arbitrary<string> {
  return slug();
}

// Strings YAML could read as another type, or that need quoting, escaping or a block scalar.
const YAML_TRICKY = [
  "",
  "yes",
  "No",
  "on",
  "true",
  "False",
  "null",
  "Null",
  "~",
  "1e100000",
  "01234567",
  "0x1F",
  "0o17",
  "1_000",
  ".inf",
  "-.Inf",
  ".nan",
  "12:30:00",
  "2026-10-22",
  "2026-10-22T10:15:00Z",
  "- item",
  "? key",
  "a: b",
  "a:b",
  "#comment",
  "value # not a comment",
  "&anchor",
  "*alias",
  "!tag",
  "!!str",
  "%YAML 1.2",
  "@at",
  "`tick",
  "|",
  "> folded",
  "'",
  '"',
  "{}",
  "[]",
  "{a: 1}",
  "---",
  "...",
  "<<",
  "=",
  " leading space",
  "trailing space ",
  "multi\nline",
  "trailing newline\n",
  "\n",
  "\n\nleading blank lines",
  "indented\n  second line",
  "line with trailing space \nnext",
  "\ttab",
  "crlf\r\nline",
  "lone\rcr",
  "unicode é 日本",
  "emoji 🦀",
  "\u0085next line",
  "line\u2028separator",
  "nul\u0000byte",
  "del\u007f",
  "back\\slash",
] as const;

const yamlTricky = once(() => {
  const tricky = fc.constantFrom(...YAML_TRICKY);
  return fc.oneof(
    tricky,
    fc.string({ unit: "grapheme", maxLength: 20 }),
    fc
      .tuple(tricky, fc.string({ unit: "grapheme", maxLength: 8 }), tricky)
      .map(([a, b, c]) => `${a}${b}${c}`),
  );
});

/** Strings that are easy to get wrong in YAML, alone or combined with arbitrary text. */
export function arbYamlTrickyString(): fc.Arbitrary<string> {
  return yamlTricky();
}

const fieldKey = once(() =>
  fc
    .oneof(fc.stringMatching(/^[a-z_][a-z0-9_]{0,10}$/), arbYamlTrickyString())
    .filter((k) => k !== "__proto__"),
);

const jsonValue = once(
  () =>
    fc.letrec<{ value: JsonValue }>((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        arbYamlTrickyString(),
        fc.array(tie("value"), { maxLength: 3 }),
        fc.dictionary(fieldKey(), tie("value"), { maxKeys: 3 }),
      ),
    })).value,
);

/** Extra fields, keyed by anything but `reserved`, that a reader must preserve. */
export function arbUnknownFields(
  reserved: readonly string[],
): fc.Arbitrary<Record<string, JsonValue>> {
  const key = reserved.length === 0 ? fieldKey() : fieldKey().filter((k) => !reserved.includes(k));
  return fc.dictionary(key, jsonValue(), { maxKeys: 3 });
}

const nonEmpty = () => arbYamlTrickyString().filter((s) => s.length > 0);

/** Valid actors; the optional keys are sometimes absent, sometimes null, plus unknown fields. */
export function arbActor(): fc.Arbitrary<Actor> {
  const optional = fc.oneof(fc.constant(undefined), fc.constant(null), arbYamlTrickyString());
  return fc
    .record({
      kind: fc.constantFrom("human" as const, "agent" as const),
      name: nonEmpty(),
      email: optional,
      agent: optional,
      agentName: nonEmpty(),
      on_behalf_of: optional,
      extra: arbUnknownFields(ACTOR_KEYS),
    })
    .map(({ kind, name, email, agent, agentName, on_behalf_of, extra }) => {
      const actor: Record<string, unknown> = { kind, name };
      if (email !== undefined) actor.email = email;
      if (kind === "agent") actor.agent = agentName;
      else if (agent !== undefined) actor.agent = agent;
      if (on_behalf_of !== undefined) actor.on_behalf_of = on_behalf_of;
      return { ...actor, ...extra } as unknown as Actor;
    });
}

const arbKindName = once(() => fc.stringMatching(/^[a-z][a-z0-9]{0,9}(?:-[a-z0-9]{1,6}){0,2}$/));

function kindTargets(kind: KindSchema, type: string | undefined): [string, string][] {
  const targets = Object.entries(kind.schemas).flatMap(([schema, v]) =>
    Object.keys(v.events)
      .filter((t) => type === undefined || t === type)
      .map((t): [string, string] => [schema, t]),
  );
  if (targets.length === 0) {
    throw new InvalidArgumentError(`kind ${kind.name} defines no event type to generate`);
  }
  return targets;
}

/**
 * Valid `ledger/v1` envelopes, with unknown fields at the envelope, actor and data levels. With a
 * kind, `schema` and `type` come from it; pass `data` when its data schemas need specific fields.
 */
export function arbEnvelope(
  o: {
    readonly kind?: KindSchema;
    readonly subject?: string;
    readonly type?: string;
    readonly data?: fc.Arbitrary<Record<string, unknown>>;
  } = {},
): fc.Arbitrary<EventEnvelope> {
  const target: fc.Arbitrary<{ kind: string; schema: string; type: string }> =
    o.kind === undefined
      ? fc
          .tuple(arbKindName(), fc.integer({ min: 1, max: 99 }), arbEventType())
          .map(([kind, v, type]) => ({ kind, schema: `${kind}/v${v}`, type: o.type ?? type }))
      : fc
          .constantFrom(...kindTargets(o.kind, o.type))
          .map(([schema, type]) => ({ kind: o.kind?.name ?? "", schema, type }));
  return fc
    .record({
      target,
      id: arbUlid(),
      subject: o.subject === undefined ? arbSubjectId() : fc.constant(o.subject),
      at: arbAt(),
      actor: arbActor(),
      reason: fc.oneof(fc.constant(undefined), fc.constant(null), nonEmpty()),
      data: o.data ?? arbUnknownFields([]),
      extra: arbUnknownFields(ENVELOPE_KEYS),
    })
    .map(({ target, id, subject, at, actor, reason, data, extra }) => ({
      envelope: ENVELOPE_VERSION,
      ...target,
      id,
      subject,
      at,
      actor,
      ...(reason === undefined ? {} : { reason }),
      data,
      ...extra,
    }));
}
