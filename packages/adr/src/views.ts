import {
  compareEvents,
  type EventEnvelope,
  type Finding,
  type StateHeader,
  UsageError,
  withGitOperation,
} from "@nikovirtala/ledger";
import type { DecisionStatus, DecisionView } from "./kind.js";
import { type ChangedSince, type DecisionsRead, listingNotes } from "./log.js";

/** The `numbering` key of the read documents. */
export interface NumberingJson {
  readonly available: boolean;
  readonly reason: "shallow" | "no-main-ref" | "no-index" | "index" | null;
  readonly ref: string | null;
}

/** `adr list --json` (design §5.5). */
export interface DecisionListJson {
  readonly format: "adr-list/v1";
  /** The `[[sources]]` entry listed (`--source`), or `null` for the local log. */
  readonly source: string | null;
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  readonly decisions: readonly DecisionView[];
  /** With `--since <rev>`: the event files added since `rev`; `null` without it. */
  readonly since: ChangedSince | null;
  /** Newer envelope or schema versions; upgrade adr. */
  readonly unreadable: readonly string[];
  /** First event not `proposed`, or a body with no events; run adr verify. */
  readonly unfoldable: readonly string[];
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

/** `adr show <decision> --json` (design §5.5). */
export interface DecisionShowJson {
  readonly format: "adr-show/v1";
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  readonly header: StateHeader;
  readonly decision: DecisionView;
  readonly body: string | null;
  /** Every valid event in fold order with `history`, else `null`. */
  readonly events: readonly EventEnvelope[] | null;
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

/** The `numbering` key of `adr-list/v1`, `adr-show/v1` and `adr-for/v1`. */
export const numberingJson = (read: DecisionsRead): NumberingJson => ({
  available: read.numbering.available,
  reason: read.numbering.reason,
  ref: read.numbering.ref,
});

/** Numbered decisions by number, then unnumbered ones by `proposed_at`, then id. */
export function compareViews(a: DecisionView, b: DecisionView): number {
  if (a.number !== null || b.number !== null) {
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    return a.number - b.number;
  }
  if (a.proposed_at !== b.proposed_at) return a.proposed_at < b.proposed_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The `adr-list/v1` document: decisions in list order, filtered by `status` and by `since` (only
 * the decisions with event files added since its revision, from `changedSince`), and truncated to
 * `limit` after ordering. `findings` are those of the listed decisions and of the log as a whole.
 */
export function listDecisions(
  read: DecisionsRead,
  o: {
    readonly status?: readonly DecisionStatus[];
    readonly since?: ChangedSince | null;
    readonly limit?: number;
  } = {},
): DecisionListJson {
  const statuses = o.status === undefined || o.status.length === 0 ? null : new Set(o.status);
  const since = o.since ?? null;
  const changed = since === null ? null : new Set(since.events.map((e) => e.subject));
  const decisions = [...read.projection.views.values()]
    .filter((v) => statuses === null || statuses.has(v.status))
    .filter((v) => changed === null || changed.has(v.id))
    .sort(compareViews)
    .slice(0, o.limit ?? Number.POSITIVE_INFINITY);
  const listed = new Set(decisions.map((v) => v.id));
  return {
    format: "adr-list/v1",
    source: read.source,
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    decisions,
    since,
    unreadable: read.projection.unreadable,
    unfoldable: read.projection.unfoldable,
    findings: read.findings.filter((f) => f.subject === null || listed.has(f.subject)),
    notes: listingNotes(read),
  };
}

const decoder = new TextDecoder();

/**
 * The `adr-show/v1` document of the decision `id` (resolve it with `resolveDecision` first).
 * Throws `UsageError` for an unknown, unreadable or unfoldable decision.
 */
export async function showDecision(
  read: DecisionsRead,
  id: string,
  o: { readonly history?: boolean } = {},
): Promise<DecisionShowJson> {
  return withGitOperation(async () => {
    const view = read.projection.views.get(id);
    if (view === undefined) {
      if (read.projection.unreadable.includes(id)) {
        throw new UsageError(`decision ${id} uses a newer format; upgrade adr`);
      }
      if (read.projection.unfoldable.includes(id)) {
        throw new UsageError(`decision ${id} can't be read; run adr verify`);
      }
      throw new UsageError(`unknown decision ${id}`);
    }
    const loaded = read.folded.subjects.get(id)?.loaded;
    const body = loaded?.body ?? null;
    const events =
      o.history === true
        ? (loaded?.events ?? [])
            .flatMap((e) => (e.event === null ? [] : [{ path: e.path, event: e.event }]))
            .sort((a, b) =>
              compareEvents({ ...a.event, path: a.path }, { ...b.event, path: b.path }),
            )
            .map((e) => e.event)
        : null;
    return {
      format: "adr-show/v1",
      root: read.root,
      ref: read.ref,
      commit: read.commit,
      numbering: numberingJson(read),
      header: stateHeader(view, read),
      decision: view,
      body: body === null ? null : decoder.decode(body.bytes),
      events,
      findings: read.findings.filter((f) => f.subject === id),
      notes: read.notes,
    };
  });
}

const day = (at: string | null) => (at ?? "").slice(0, 10);

/** The reason on the applied event that produced the decision's current status, if any. */
function statusReason(read: DecisionsRead, id: string): string | null {
  const applied = read.folded.subjects.get(id)?.applied ?? [];
  const last = applied.findLast((a) => a.from !== a.to);
  const reason = last?.event.reason;
  return typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
}

/**
 * The state header (01:258–259): `<display> (<id>) · <status>`, and for a decision that isn't in
 * force a warning saying what to read instead. `refer` names where to read another decision. CLI
 * default: `display(id)`. Phase 3 MCP passes `id => "adr://decision/" + display(id)`, e.g.
 * `adr://decision/ADR-0012`, or the id when unnumbered.
 */
export function stateHeader(
  view: DecisionView,
  read: DecisionsRead,
  o: { readonly refer?: (id: string) => string } = {},
): StateHeader {
  const display = (id: string) => read.projection.views.get(id)?.display ?? id;
  const refer = o.refer ?? display;
  const line =
    view.number === null
      ? `${view.id} · ${view.status}`
      : `${view.display} (${view.id}) · ${view.status}`;
  const parts: string[] = [];
  const reason = statusReason(read, view.id);
  const when = day(view.status_at);
  switch (view.status) {
    case "superseded": {
      const target = view.effective ?? view.superseded_by ?? view.id;
      const accepted = read.projection.views.get(target)?.decided_at ?? null;
      const date = accepted === null ? "" : ` (accepted ${day(accepted)})`;
      parts.push(
        `SUPERSEDED by ${display(target)}${date}. Do not apply this decision; read ${refer(target)} instead.`,
      );
      if (view.chain.length > 2) parts.push(`Chain: ${view.chain.map(display).join(" → ")}.`);
      break;
    }
    case "deprecated":
      parts.push(`DEPRECATED on ${when}: ${reason ?? "no reason given"}. No decision replaces it.`);
      break;
    case "rejected":
      parts.push(
        `REJECTED on ${when}: ${reason ?? "no reason given"}. This decision was never in force.`,
      );
      break;
    case "withdrawn":
      parts.push(
        `WITHDRAWN on ${when}${reason === null ? "" : `: ${reason}`}. This decision was never in force.`,
      );
      break;
    default:
      break;
  }
  if (view.body_intact === false) {
    parts.push("WARNING: the body changed after acceptance; run adr verify.");
  }
  return { line, warning: parts.length === 0 ? null : parts.join(" ") };
}
