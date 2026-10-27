import type { FoldedLog, FoldedSubject, KindFinding } from "@nikovirtala/ledger";
import type { DecisionState } from "./reduce.js";
import type { DecisionEvents, DecisionStatus } from "./schemas.js";

/** A decision in another repository's log, as the reference rules and `--source` listings see it. */
export interface ForeignDecision {
  readonly status: DecisionStatus;
  readonly display: string;
  readonly title: string;
}

/** One `[[sources]]` entry of kind `adr`, as `AdrOptions.sources` holds it. */
export interface AdrSource {
  /** The decisions at the cached commit; `null` when the source isn't cached (not checked). */
  readonly subjects: ReadonlyMap<string, ForeignDecision> | null;
  /** The cached commit, or `null`. */
  readonly commit: string | null;
}

/** Options of the decision kind's `invariants` and `relate`. */
export interface AdrOptions {
  /** Default `true`: an agent may propose, but only a human may accept (01:98). */
  readonly acceptRequiresHuman: boolean;
  /**
   * The `kind = "adr"` `[[sources]]` by name, for checking qualified references; `null` (the
   * default) skips qualified references, as reads that don't load sources do.
   */
  readonly sources: ReadonlyMap<string, AdrSource> | null;
}

type Subject = FoldedSubject<DecisionStatus, DecisionState, DecisionEvents>;
type Log = FoldedLog<DecisionStatus, DecisionState, DecisionEvents>;

/** `decision/agent-accepted`: an applied `accepted` event written by an agent under the human policy. */
export function invariants(subject: Subject, options: AdrOptions): readonly KindFinding[] {
  if (!options.acceptRequiresHuman) return [];
  return subject.applied.flatMap(({ event }) =>
    event.type === "accepted" && event.actor.kind === "agent"
      ? [
          {
            severity: "error" as const,
            rule: "decision/agent-accepted",
            message: `accepted by agent ${event.actor.name}; accept_requires_human needs a human`,
            subject: subject.id,
            event: event.id,
          },
        ]
      : [],
  );
}

/** Qualified ids (`<source>:<id>`) name decisions in other logs. */
const isQualified = (ref: string) => ref.includes(":");

/**
 * Cross-subject rules: `decision/reference-missing` for a local `supersedes`, `superseded.by` or
 * `linked.to` naming no subject in the log; `decision/superseded-by-unaccepted` when the target of
 * an applied `superseded.by` has no applied `accepted` event in this tree; and
 * `decision/supersession-cycle`, once per cycle on its smallest id. With `options.sources`, a
 * qualified reference naming a source that isn't configured is `decision/unknown-source`, and one
 * into a cached source that doesn't hold the id is `decision/reference-missing`; references into
 * an uncached source aren't checked.
 */
export function relate(log: Log, options?: AdrOptions): readonly KindFinding[] {
  const out: KindFinding[] = [];
  const sources = options?.sources ?? null;
  const isAccepted = (id: string) =>
    log.subjects.get(id)?.applied.some((a) => a.event.type === "accepted") ?? false;
  const foreign = (subject: string, event: string, ref: string, what: string) => {
    if (sources === null) return;
    const at = ref.indexOf(":");
    const name = ref.slice(0, at);
    const id = ref.slice(at + 1);
    const source = sources.get(name);
    if (source === undefined) {
      out.push({
        severity: "error",
        rule: "decision/unknown-source",
        message: `${what} ${ref}, whose source ${name} isn't in [[sources]]`,
        subject,
        event,
      });
      return;
    }
    if (source.subjects === null || source.subjects.has(id)) return;
    out.push({
      severity: "error",
      rule: "decision/reference-missing",
      message: `${what} ${ref}, which is not in source ${name} at ${(source.commit ?? "").slice(0, 12)}`,
      subject,
      event,
    });
  };
  const missing = (subject: string, event: string, ref: string, what: string) => {
    if (isQualified(ref)) {
      foreign(subject, event, ref, what);
      return false;
    }
    if (log.subjects.has(ref)) return false;
    out.push({
      severity: "error",
      rule: "decision/reference-missing",
      message: `${what} ${ref}, which is not in the log`,
      subject,
      event,
      related: [ref],
    });
    return true;
  };

  for (const [id, s] of log.subjects) {
    for (const { event } of s.applied) {
      switch (event.type) {
        case "proposed":
          for (const ref of event.data.supersedes ?? []) missing(id, event.id, ref, "supersedes");
          break;
        case "superseded": {
          const by = event.data.by;
          if (missing(id, event.id, by, "superseded by") || isQualified(by)) break;
          if (!isAccepted(by)) {
            out.push({
              severity: "error",
              rule: "decision/superseded-by-unaccepted",
              message: `superseded by ${by}, which is not accepted`,
              subject: id,
              event: event.id,
              related: [by],
            });
          }
          break;
        }
        case "linked":
          missing(id, event.id, event.data.to, "links to");
          break;
        default:
          break;
      }
    }
  }

  const next = (id: string) => log.subjects.get(id)?.state?.supersededBy ?? null;
  const reported = new Set<string>();
  for (const start of log.subjects.keys()) {
    const path: string[] = [];
    let cur: string | null = start;
    while (cur !== null && !path.includes(cur)) {
      path.push(cur);
      cur = next(cur);
    }
    if (cur === null) continue;
    const cycle = path.slice(path.indexOf(cur));
    const smallest = [...cycle].sort()[0];
    if (smallest === undefined || reported.has(smallest)) continue;
    reported.add(smallest);
    const from = cycle.indexOf(smallest);
    const ordered = [...cycle.slice(from), ...cycle.slice(0, from), smallest];
    const event = log.subjects.get(smallest)?.applied.find((a) => a.event.type === "superseded")
      ?.event.id;
    out.push({
      severity: "error",
      rule: "decision/supersession-cycle",
      message: `supersession cycle: ${ordered.join(" → ")}`,
      subject: smallest,
      ...(event === undefined ? {} : { event }),
      related: [...cycle].sort(),
    });
  }
  return out;
}
