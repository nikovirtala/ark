import type { FoldedSubject, ProjectContext } from "@nikovirtala/ledger";
import type { DecisionState } from "./reduce.js";
import type { DecisionEvents, DecisionStatus } from "./schemas.js";

/** One decision as the CLI, the library and MCP show it (01:173–192, plus the added fields). */
export interface DecisionView {
  readonly id: string;
  readonly number: number | null;
  /** `ADR-0007`, or the id when unnumbered. */
  readonly display: string;
  readonly title: string;
  readonly status: DecisionStatus;
  readonly superseded_by: string | null;
  /** Ids whose applied `superseded.by` is this id, sorted. */
  readonly supersedes: readonly string[];
  /** The proposal's intent (01:164). */
  readonly declared_supersedes: readonly string[];
  /** Head of the `superseded_by` chain; `null` only on a cycle. */
  readonly effective: string | null;
  /** `[id, …, effective]`, following `superseded_by` forward. */
  readonly chain: readonly string[];
  readonly template: { readonly name: string; readonly version: number };
  readonly body_path: string | null;
  /** Recorded at acceptance. */
  readonly body_sha256: string | null;
  /** `null` until accepted; whether the current body hash equals the recorded one. */
  readonly body_intact: boolean | null;
  readonly links: readonly { readonly to: string; readonly rel: string }[];
  readonly applies_to: readonly string[];
  readonly notes: number;
  readonly proposed_at: string;
  readonly decided_at: string | null;
  readonly status_at: string;
  /** `proposed 2026-03-12`: state-changing events, in fold order. */
  readonly history: readonly string[];
}

type Subject = FoldedSubject<DecisionStatus, DecisionState, DecisionEvents>;
type Context = ProjectContext<DecisionStatus, DecisionState, DecisionEvents>;

const NUMBER = /^(?:adr-?)?0*([1-9][0-9]{0,8})$/i;

/** `ADR-0007`: at least 4 digits, growing past 9999. */
export function formatDecisionNumber(n: number): string {
  return `ADR-${String(n).padStart(4, "0")}`;
}

/** `7`, `0007`, `ADR-7`, `adr-0007` → 7; `null` for anything else. */
export function parseDecisionNumber(s: string): number | null {
  const m = NUMBER.exec(s.trim());
  return m === null ? null : Number(m[1]);
}

/**
 * Follows `superseded_by` from `id`. A visited set stops on a cycle (`effective: null`); a
 * reference to a subject that isn't folded ends the chain there.
 */
function chainOf(id: string, ctx: Context): { chain: string[]; effective: string | null } {
  const chain = [id];
  let cur = id;
  for (;;) {
    const next = ctx.log.subjects.get(cur)?.state?.supersededBy ?? null;
    if (next === null) return { chain, effective: cur };
    if (chain.includes(next)) return { chain, effective: null };
    chain.push(next);
    cur = next;
  }
}

/** Pure: the view of one folded decision. */
export function project(subject: Subject, ctx: Context): DecisionView {
  const { id } = subject;
  const s = subject.state;
  if (s === null || subject.status === null) {
    throw new Error(`decision ${id} is not folded`);
  }
  const supersedes = [...ctx.log.subjects.values()]
    .filter((o) => o.id !== id && o.state?.supersededBy === id)
    .map((o) => o.id)
    .sort();
  const { chain, effective } = chainOf(id, ctx);
  const current = ctx.bodySha256(id);
  return {
    id,
    number: ctx.number(id),
    display: ctx.display(id),
    title: s.title,
    status: subject.status,
    superseded_by: s.supersededBy,
    supersedes,
    declared_supersedes: s.declaredSupersedes,
    effective,
    chain,
    template: s.template,
    body_path: subject.loaded.body?.path ?? subject.loaded.bodyPaths[0] ?? null,
    body_sha256: s.bodySha256,
    body_intact: s.bodySha256 === null ? null : current === s.bodySha256,
    links: s.links,
    applies_to: s.appliesTo,
    notes: s.notes,
    proposed_at: s.proposedAt,
    decided_at: s.decidedAt,
    status_at: s.statusAt,
    history: s.history.map((h) => `${h.type} ${h.at.slice(0, 10)}`),
  };
}
