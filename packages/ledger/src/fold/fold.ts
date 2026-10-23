import type { EventEnvelope } from "../envelope/types.js";
import { InvalidArgumentError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import type {
  AnyKind,
  AppliedEvent,
  FoldedLogOf,
  FoldedSubject,
  FoldedSubjectOf,
} from "../kind/types.js";
import type { LoadedSubject, LogSnapshot } from "../log/snapshot.js";

type Applied = AppliedEvent<string, AnyKind["def"]["events"]>;
type Skipped = FoldedSubject<string, unknown, AnyKind["def"]["events"]>["skipped"][number];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `(at, id)`, then path, so duplicate ids still order deterministically. */
export function compareEvents(
  a: { readonly at: string; readonly id: string; readonly path?: string },
  b: { readonly at: string; readonly id: string; readonly path?: string },
): number {
  return cmp(a.at, b.at) || cmp(a.id, b.id) || cmp(a.path ?? "", b.path ?? "");
}

const error = (rule: string, message: string, file: string, subject: string) =>
  finding({ severity: "error", rule, message, file, subject });

/**
 * Replays a subject's valid events in `(at, id)` order through the kind's state machine. The
 * first event must be the initial type; later events that the machine doesn't allow in the current
 * status are skipped with a `transition/illegal` finding and leave the state unchanged.
 */
export function foldSubject<K extends AnyKind>(kind: K, s: LoadedSubject): FoldedSubjectOf<K> {
  const { def, machine } = kind;
  const result = (o: {
    status: string | null;
    state: unknown;
    applied?: Applied[];
    skipped?: Skipped[];
    findings?: Finding[];
  }) =>
    ({
      id: s.id,
      status: o.status,
      state: o.state,
      applied: o.applied ?? [],
      skipped: o.skipped ?? [],
      findings: o.findings ?? [],
      loaded: s,
    }) as FoldedSubjectOf<K>;

  if (!s.readable) return result({ status: null, state: null });
  const events = s.events
    .flatMap((e) => (e.event === null ? [] : [{ path: e.path, event: e.event }]))
    .sort((a, b) => compareEvents({ ...a.event, path: a.path }, { ...b.event, path: b.path }));
  const [first] = events;
  if (first === undefined) {
    const body = s.bodyPaths[0];
    const noEvents =
      body !== undefined && s.events.length === 0
        ? [
            error(
              "transition/no-events",
              `body file has no events; its first event must be ${machine.initial.type}`,
              body,
              s.id,
            ),
          ]
        : [];
    return result({ status: null, state: null, findings: noEvents });
  }
  if (first.event.type !== machine.initial.type) {
    return result({
      status: null,
      state: null,
      skipped: events.map(({ path, event }) => ({ path, event, rule: "transition/not-initial" })),
      findings: [
        error(
          "transition/not-initial",
          `first event is ${first.event.type}; it must be ${machine.initial.type}`,
          first.path,
          s.id,
        ),
      ],
    });
  }

  const reduce = (state: unknown, event: EventEnvelope) =>
    def.reduce(state, event as Parameters<AnyKind["def"]["reduce"]>[1]);
  let status: string = machine.initial.to;
  let state = reduce(null, first.event);
  const applied: Applied[] = [
    { event: first.event as Applied["event"], path: first.path, from: null, to: status },
  ];
  const skipped: Skipped[] = [];
  const findings: Finding[] = [];
  for (const { path, event } of events.slice(1)) {
    if (!machine.allowed(status, event.type)) {
      const terminal = machine.terminal.includes(status) ? `; ${status} is terminal` : "";
      skipped.push({ path, event, rule: "transition/illegal" });
      findings.push(
        error(
          "transition/illegal",
          `${event.type} is not allowed while ${status}${terminal}`,
          path,
          s.id,
        ),
      );
      continue;
    }
    const from = status;
    status = machine.types.get(event.type)?.to ?? status;
    state = reduce(state, event);
    applied.push({ event: event as Applied["event"], path, from, to: status });
  }
  return result({ status, state, applied, skipped, findings });
}

/** Folds every subject of a snapshot loaded with this kind; throws `InvalidArgumentError` otherwise. */
export function foldLog<K extends AnyKind>(kind: K, snap: LogSnapshot): FoldedLogOf<K> {
  if (snap.kind.kind !== kind) {
    throw new InvalidArgumentError(
      `the snapshot was loaded with kind ${snap.kind.kind.name}, not this ${kind.name} kind`,
    );
  }
  const subjects = new Map<string, FoldedSubjectOf<K>>();
  for (const [id, s] of snap.subjects) subjects.set(id, foldSubject(kind, s));
  return { kind, snapshot: snap, subjects } as unknown as FoldedLogOf<K>;
}
