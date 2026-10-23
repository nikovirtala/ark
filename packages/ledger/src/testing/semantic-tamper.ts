import fc from "fast-check";
import type { EventEnvelope } from "../envelope/types.js";
import { ENVELOPE_VERSION } from "../envelope/version.js";
import { serializeEvent } from "../envelope/yaml.js";
import { InvalidArgumentError } from "../errors.js";
import { bodyFileName } from "../identity/files.js";
import { bodySha256 } from "../identity/hash.js";
import { newSubjectId } from "../identity/ids.js";
import { eventPath } from "../identity/layout.js";
import { formatAt } from "../identity/time.js";
import { createUlidFactory } from "../identity/ulid.js";
import type { AnyKind } from "../kind/types.js";
import { nextEventIdentity } from "../log/write.js";
import {
  type DataArbs,
  finalHistoryContext,
  type HistoryContext,
  type LegalHistory,
  TEST_HUMAN,
} from "./history.js";

/** A semantic tampering of a legal history: one new file at `path`; no existing file changes. */
export type SemanticTamper =
  /** An event of a state-changing type the machine doesn't allow in the subject's final status. */
  | { readonly type: "illegal-transition"; readonly path: string; readonly content: string }
  /** An event of a non-initial type that sorts before the subject's initial event. */
  | { readonly type: "not-initial"; readonly path: string; readonly content: string }
  /** An allowed event of a type that requires a reason, without one. */
  | { readonly type: "missing-reason"; readonly path: string; readonly content: string }
  /** A body file for a subject that has no events. */
  | { readonly type: "body-without-events"; readonly path: string; readonly content: string };

type TamperType = SemanticTamper["type"];

/** The rules verify may report for each semantic tamper; at least one fires, as an error. */
export const semanticExpectedRules: Readonly<Record<TamperType, readonly string[]>> = Object.freeze(
  {
    "illegal-transition": ["transition/illegal"],
    "not-initial": ["transition/not-initial"],
    "missing-reason": ["event/reason-required"],
    "body-without-events": ["transition/no-events"],
  },
);

const ALL_TYPES = Object.keys(semanticExpectedRules) as TamperType[];
const arbRandom = fc.uint8Array({ minLength: 10, maxLength: 10 });
const arbReason = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== "");
const fill = (bytes: Uint8Array) => (buf: Uint8Array) => buf.set(bytes.subarray(0, buf.length));
const encoder = new TextEncoder();

type DataArb = (ctx: HistoryContext) => fc.Arbitrary<Record<string, unknown>> | null;

/**
 * One semantic tamper of `h`, or `null` when no allowed tamper type has a candidate. Each type
 * joins the choice only when the history has a candidate for it; `only` restricts the types.
 * Events get their data from `o.data` with the subject's final context, a body hash that matches
 * for the freeze type, a reason when required (except for `missing-reason`) and `TEST_HUMAN`.
 */
export function arbSemanticTamper<K extends AnyKind>(
  h: LegalHistory<K>,
  o: {
    readonly kind: K;
    readonly data: DataArbs<K>;
    /** Restrict to these tamper types (default: all). */
    readonly only?: readonly TamperType[];
  },
): fc.Arbitrary<SemanticTamper> | null {
  const { kind } = o;
  const { machine } = kind;
  const { layout } = h;
  const data = o.data as unknown as Readonly<Record<string, DataArb>>;
  const allowed = new Set(o.only ?? ALL_TYPES);
  const taken = (path: string) => Object.hasOwn(h.files, path);
  const freeze =
    typeof kind.body === "object"
      ? { type: kind.body.freezeOn, field: kind.body.hashField ?? "body_sha256" }
      : null;
  const latest = h.steps.at(-1)?.event.at;

  interface Subject {
    readonly id: string;
    readonly status: string | null;
    readonly ctx: HistoryContext;
    readonly events: readonly EventEnvelope[];
    readonly body: string;
  }
  const subjects: Subject[] = h.subjects.map((s) => {
    const ctx = finalHistoryContext(h, kind, s.id);
    return {
      id: s.id,
      status: ctx.status(s.id),
      ctx,
      events: h.steps.filter((x) => x.subject === s.id).map((x) => x.event),
      body: s.bodyPath === null ? "" : (h.files[s.bodyPath] ?? ""),
    };
  });
  const fillable = (s: Subject, type: string) => {
    const make = data[type];
    if (make === undefined) throw new InvalidArgumentError(`o.data has no entry for ${type}`);
    return make(s.ctx);
  };
  const types = [...machine.types];

  /** Candidates as (subject, type, data) for the types `keep` accepts. */
  const pairs = (keep: (s: Subject, type: string, to: string | null, reason: string) => boolean) =>
    subjects.flatMap((s) =>
      types.flatMap(([type, t]) => {
        if (!keep(s, type, t.to, t.reason)) return [];
        const arb = fillable(s, type);
        return arb === null ? [] : [{ s, type, arb }];
      }),
    );

  type Pair = ReturnType<typeof pairs>[number];
  const event = (
    p: Pair,
    place: (random: (buf: Uint8Array) => void) => { at: string; id: string },
    withReason: boolean,
  ) =>
    fc.tuple(p.arb, arbRandom, arbReason).map(([d, bytes, reason]) => {
      const { at, id } = place(fill(bytes));
      const filled =
        freeze !== null && p.type === freeze.type
          ? { ...d, [freeze.field]: bodySha256(encoder.encode(p.s.body)) }
          : d;
      const e: EventEnvelope = {
        envelope: ENVELOPE_VERSION,
        kind: kind.name,
        schema: kind.schema,
        id,
        subject: p.s.id,
        type: p.type,
        at,
        actor: TEST_HUMAN,
        ...(withReason ? { reason } : {}),
        data: filled,
      };
      return { path: eventPath(layout, e), content: serializeEvent(e) };
    });
  /** After every event of the history: evaluated against the final status. */
  const last = (p: Pair) => (random: (buf: Uint8Array) => void) => {
    const now = Date.parse(latest ?? "2001-01-01T00:00:00Z") + 1000;
    return nextEventIdentity(p.s.events, { now: () => now, random });
  };
  const needsReason = (type: string) => machine.types.get(type)?.reason === "required";

  const candidates: fc.Arbitrary<SemanticTamper>[] = [];
  const add = (type: TamperType, arb: fc.Arbitrary<{ path: string; content: string }>) =>
    candidates.push(arb.filter((m) => !taken(m.path)).map((m) => ({ type, ...m })));

  if (allowed.has("illegal-transition")) {
    const all = pairs(
      (s, type, to) => s.status !== null && to !== null && !machine.allowed(s.status, type),
    );
    const terminal = all.filter(
      (p) => p.s.status !== null && machine.terminal.includes(p.s.status),
    );
    const chosen = terminal.length > 0 ? terminal : all;
    if (chosen.length > 0) {
      add(
        "illegal-transition",
        fc.constantFrom(...chosen).chain((p) => event(p, last(p), needsReason(p.type))),
      );
    }
  }
  if (allowed.has("not-initial")) {
    const all = pairs((s, type) => s.events.length > 0 && type !== machine.initial.type);
    if (all.length > 0) {
      const before = (p: Pair) => (random: (buf: Uint8Array) => void) => {
        const first = p.s.events[0]?.at ?? "";
        const at = formatAt(Date.parse(first) - 1000);
        return { at, id: createUlidFactory({ now: () => Date.parse(at), random })() };
      };
      add(
        "not-initial",
        fc.constantFrom(...all).chain((p) => event(p, before(p), needsReason(p.type))),
      );
    }
  }
  if (allowed.has("missing-reason")) {
    const all = pairs(
      (s, type, _to, reason) =>
        s.status !== null && reason === "required" && machine.allowed(s.status, type),
    );
    if (all.length > 0) {
      add(
        "missing-reason",
        fc.constantFrom(...all).chain((p) => event(p, last(p), false)),
      );
    }
  }
  if (allowed.has("body-without-events") && layout.bodies !== null && kind.body !== "none") {
    const bodies = layout.bodies;
    const ids = new Set(subjects.map((s) => s.id));
    add(
      "body-without-events",
      fc
        .tuple(
          fc.uint8Array({ minLength: 5, maxLength: 5 }),
          fc.constantFrom("", "orphan"),
          fc.string({ maxLength: 80 }),
        )
        .map(([bytes, slug, content]) => ({ id: newSubjectId(fill(bytes)), slug, content }))
        .filter(({ id }) => !ids.has(id))
        .map(({ id, slug, content }) => ({
          path: `${layout.root}/${bodies}/${bodyFileName(id, slug)}`,
          content,
        })),
    );
  }
  return candidates.length === 0 ? null : fc.oneof(...candidates);
}

/** A new map with the tamper's file added; `files` is never mutated. */
export function applySemanticTamper(
  files: Readonly<Record<string, string>>,
  m: SemanticTamper,
): Record<string, string> {
  if (Object.hasOwn(files, m.path)) throw new InvalidArgumentError(`a file exists at ${m.path}`);
  return { ...files, [m.path]: m.content };
}
