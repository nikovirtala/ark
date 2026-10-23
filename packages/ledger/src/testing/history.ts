import fc from "fast-check";
import type { Actor, EventEnvelope } from "../envelope/types.js";
import { ENVELOPE_VERSION } from "../envelope/version.js";
import { InvalidArgumentError } from "../errors.js";
import { bodyFileName, eventFileName } from "../identity/files.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath, type LogLayout } from "../identity/layout.js";
import type { AnyKind, DataOfType, EventTypesOf } from "../kind/types.js";
import { nextEventIdentity } from "../log/write.js";
import { arbSubjectId } from "./arbitraries.js";
import { type LogFixture, type LogFixtureSubjectInput, logFixtureFiles } from "./log-fixture.js";

/** What a `DataArbs` entry knows when `arbLegalHistory` asks it for the next event's data. */
export interface HistoryContext {
  /** The subject the next event is for. */
  readonly subject: string;
  /** Subjects that already have their initial event, in creation order (includes `subject` unless it is new). */
  readonly subjects: readonly string[];
  status(id: string): string | null;
  state(id: string): unknown;
}

/**
 * Per event type, the data of the next event, or `null` when the type isn't applicable now. The
 * freeze type's hash field is filled from the body, so its entry may leave it out.
 */
export type DataArbs<K extends AnyKind> = {
  readonly [T in EventTypesOf<K>]: (
    ctx: HistoryContext,
  ) => fc.Arbitrary<Partial<DataOfType<K, T>>> | null;
};

export interface LegalHistory<K extends AnyKind> extends LogFixture {
  readonly kind: K;
  /** Every event in global generation order (non-decreasing `at`), for merges and command models. */
  readonly steps: readonly {
    readonly subject: string;
    readonly path: string;
    readonly event: EventEnvelope;
  }[];
}

/** The default actor of generated histories. */
export const TEST_HUMAN: Actor = Object.freeze({
  kind: "human",
  name: "Test",
  email: "test@example.com",
  agent: null,
  on_behalf_of: null,
});

const FIRST_AT = {
  min: Date.parse("2001-01-01T00:00:00Z"),
  max: Date.parse("2090-01-01T00:00:00Z"),
};
const DAY = 86_400;
const defaultReason = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== "");
const fill = (bytes: Uint8Array) => (buf: Uint8Array) => buf.set(bytes);

/** Adds 1 to `bytes` as a big-endian number, wrapping around. */
function increment(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = ((bytes[i] ?? 0) + 1) & 0xff;
    if (bytes[i] !== 0) return;
  }
}

/** Statuses and states of subjects, advanced one applied event at a time. */
class Replay {
  readonly order: string[] = [];
  readonly #status = new Map<string, string>();
  readonly #state = new Map<string, unknown>();
  readonly #kind: AnyKind;

  constructor(kind: AnyKind) {
    this.#kind = kind;
  }

  apply(e: EventEnvelope): void {
    const { machine, def } = this.#kind;
    const status = this.#status.get(e.subject);
    if (status === undefined) this.order.push(e.subject);
    const to = machine.types.get(e.type)?.to ?? status;
    if (to === undefined) throw new InvalidArgumentError(`no status for ${e.type} on ${e.subject}`);
    this.#status.set(e.subject, to);
    this.#state.set(e.subject, def.reduce(this.#state.get(e.subject) ?? null, e as never));
  }

  status(id: string): string | null {
    return this.#status.get(id) ?? null;
  }

  context(subject: string): HistoryContext {
    return {
      subject,
      subjects: [...this.order],
      status: (id) => this.status(id),
      state: (id) => this.#state.get(id) ?? null,
    };
  }
}

type DataArb = (ctx: HistoryContext) => fc.Arbitrary<Record<string, unknown>> | null;

/**
 * Legal histories of a kind: each step picks a subject and a type the state machine allows in its
 * current status (the initial type for a new subject), with data from `o.data`. `at` is
 * non-decreasing across steps and repeats with probability `o.ties`; each subject's `(at, id)` is
 * strictly increasing. The freeze type's hash field records the subject's body.
 */
export function arbLegalHistory<K extends AnyKind>(
  kind: K,
  o: {
    /** Default `kind.layoutAt("log")`. */
    readonly layout?: LogLayout;
    readonly data: DataArbs<K>;
    /** Body text per subject; required for kinds with bodies. */
    readonly body?: (subject: string) => fc.Arbitrary<string>;
    /** Extra files (for example templates) added to `files`. */
    readonly files?: Readonly<Record<string, string>>;
    /** Default 1..4. */
    readonly subjects?: { readonly min: number; readonly max: number };
    /** Default 20. */
    readonly maxSteps?: number;
    /** Probability that a step reuses the previous step's `at`. Default 0.3. */
    readonly ties?: number;
    readonly reason?: fc.Arbitrary<string>;
    /** Default: always `TEST_HUMAN`. */
    readonly actor?: fc.Arbitrary<Actor>;
  },
): fc.Arbitrary<LegalHistory<K>> {
  const layout = o.layout ?? kind.layoutAt("log");
  const hasBodies = kind.body !== "none";
  if (hasBodies !== (layout.bodies !== null)) {
    throw new InvalidArgumentError(
      `kind ${kind.name} body policy and layout bodies must both be set or both be absent`,
    );
  }
  const body = o.body;
  if (hasBodies && body === undefined) {
    throw new InvalidArgumentError(`kind ${kind.name} has bodies; pass o.body`);
  }
  const freeze =
    typeof kind.body === "object"
      ? { type: kind.body.freezeOn, field: kind.body.hashField ?? "body_sha256" }
      : null;
  const data = o.data as unknown as Readonly<Record<string, DataArb>>;
  const minSubjects = o.subjects?.min ?? 1;
  const maxSubjects = o.subjects?.max ?? 4;
  const maxSteps = o.maxSteps ?? 20;
  const ties = Math.round((o.ties ?? 0.3) * 1000);
  const reason = o.reason ?? defaultReason;
  const actor = o.actor ?? fc.constant(TEST_HUMAN);
  const { machine } = kind;
  const dataArb = (type: string, ctx: HistoryContext) => {
    const make = data[type];
    if (make === undefined) throw new InvalidArgumentError(`o.data has no entry for ${type}`);
    return make(ctx);
  };

  return fc.gen().map((g): LegalHistory<K> => {
    const count = g(fc.integer, { min: minSubjects, max: maxSubjects });
    const ids = g(() => fc.uniqueArray(arbSubjectId(), { minLength: count, maxLength: count }));
    const total = g(fc.integer, { min: count, max: Math.max(count, maxSteps) });
    const replay = new Replay(kind);
    const events = new Map<string, EventEnvelope[]>(ids.map((id) => [id, []]));
    const bodies = new Map<string, { text: string; slug: string }>();
    const steps: { subject: string; path: string; event: EventEnvelope }[] = [];
    let clock = g(fc.integer, { min: FIRST_AT.min / 1000, max: FIRST_AT.max / 1000 });

    for (let step = 0; step < total; step++) {
      const created = new Set(replay.order);
      const fresh = ids.filter((id) => !created.has(id));
      // Leave room for every subject's initial event.
      const mustCreate = fresh.length >= total - step;
      const options = (mustCreate ? fresh : ids).flatMap((id) => {
        const status = replay.status(id);
        if (status === null) return [{ id, types: [machine.initial.type] }];
        const ctx = replay.context(id);
        const types = machine.next(status).filter((t) => dataArb(t, ctx) !== null);
        return types.length === 0 ? [] : [{ id, types }];
      });
      if (options.length === 0) break;
      const { id: subject, types } = g(fc.constantFrom, ...options);
      const type = g(fc.constantFrom, ...types);

      if (step > 0) {
        const tie = g(fc.integer, { min: 0, max: 999 }) < ties;
        if (!tie) clock += g(fc.integer, { min: 1, max: DAY });
      }
      if (replay.status(subject) === null && body !== undefined) {
        bodies.set(subject, {
          text: g(() => body(subject)),
          slug: g(fc.constantFrom, "", "widget", "a-b"),
        });
      }
      const ctx = replay.context(subject);
      const arb = dataArb(type, ctx);
      if (arb === null)
        throw new InvalidArgumentError(`o.data.${type} returned null for ${subject}`);
      let eventData: Record<string, unknown> = g(() => arb);
      if (freeze !== null && type === freeze.type) {
        const text = bodies.get(subject)?.text ?? "";
        eventData = { ...eventData, [freeze.field]: bodySha256(new TextEncoder().encode(text)) };
      }
      const previous = events.get(subject) ?? [];
      const now = clock * 1000;
      const bytes = Uint8Array.from(g(fc.uint8Array, { minLength: 10, maxLength: 10 }));
      let { at, id } = nextEventIdentity(previous, { now: () => now, random: fill(bytes) });
      // Generated bytes repeat far more often than real randomness: two events of one type in the
      // same second can get the same file name. Bump the bytes until the name is new; drawing
      // again would loop forever while shrinking.
      const taken = new Set(previous.map((p) => eventFileName(p)));
      while (taken.has(eventFileName({ at, id, type }))) {
        increment(bytes);
        ({ at, id } = nextEventIdentity(previous, { now: () => now, random: fill(bytes) }));
      }
      const needsReason = machine.types.get(type)?.reason === "required";
      const event: EventEnvelope = {
        envelope: ENVELOPE_VERSION,
        kind: kind.name,
        schema: kind.schema,
        id,
        subject,
        type,
        at,
        actor: g(() => actor),
        ...(needsReason ? { reason: g(() => reason) } : {}),
        data: eventData,
      };
      previous.push(event);
      events.set(subject, previous);
      replay.apply(event);
      steps.push({ subject, path: eventPath(layout, event), event });
    }

    const inputs: LogFixtureSubjectInput[] = replay.order.map((id) => {
      const b = bodies.get(id);
      return {
        id,
        ...(b === undefined ? {} : { body: b.text, slug: b.slug }),
        events: events.get(id) ?? [],
      };
    });
    return {
      kind,
      layout,
      files: { ...logFixtureFiles({ layout, subjects: inputs }), ...o.files },
      subjects: inputs.map((s) => ({
        id: s.id,
        bodyPath:
          s.body === undefined || layout.bodies === null
            ? null
            : `${layout.root}/${layout.bodies}/${bodyFileName(s.id, s.slug ?? "")}`,
        frozen: freeze !== null && s.events.some((e) => e.type === freeze.type),
        events: s.events
          .map((event) => ({ path: eventPath(layout, event), event }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      })),
      steps,
    };
  });
}

/** The `HistoryContext` that `arbLegalHistory` would pass for one more step on `subject`. */
export function finalHistoryContext<K extends AnyKind>(
  h: LegalHistory<K>,
  kind: K,
  subject: string,
): HistoryContext {
  const replay = new Replay(kind);
  for (const { event } of h.steps) replay.apply(event);
  return replay.context(subject);
}
