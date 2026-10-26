import type { FoldedLog, FoldedSubject } from "@nikovirtala/ledger";
import type { IssueState } from "./reduce.js";
import type { IssueEvents, IssueStatus, Rel } from "./schemas.js";

type Subject = FoldedSubject<IssueStatus, IssueState, IssueEvents>;
type Log = FoldedLog<IssueStatus, IssueState, IssueEvents>;

/** One edge of a relation graph: `from` → `to`, through the duplicate `via` for an effective edge. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** The duplicate the edge goes through (`X → C via T`); `null` for a stored (raw) edge. */
  readonly via: string | null;
  /** The event that made the link behind the edge current (`IssueLink.event`). */
  readonly event: string;
}

/** One strongly connected component that is a cycle, as `issue/cycle` reports it. */
export interface GraphCycle {
  readonly rel: "depends-on" | "part-of";
  /** The smallest id of the component (UTF-16 order). */
  readonly subject: string;
  /**
   * The component's other ids and the duplicates its effective edges go through (each `via` and
   * the later duplicates on its way to the canonical issue), sorted; so a change to any of them
   * keeps the finding in a `"changed"` scope.
   */
  readonly related: readonly string[];
  /** The shortest cycle from `subject` back to it, as edges. */
  readonly path: readonly GraphEdge[];
}

/** The derived relation fields of one folded issue (design "Derived fields"). */
export interface DerivedFields {
  readonly depends_on: readonly string[];
  readonly blocks: readonly string[];
  readonly blocked_by_open: readonly string[];
  readonly blocked: boolean;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly relates_to: readonly string[];
  readonly implements: readonly string[];
  readonly duplicates: readonly string[];
  readonly canonical: string | null;
  readonly ready: boolean;
}

/** The relation graph of one folded issue log, built once per `FoldedLog`. */
export interface IssueGraph {
  /** Follows `duplicate_of` to the last folded issue on the chain; `null` on a duplicate cycle. */
  canonicalOf(id: string): string | null;
  /**
   * The duplicates `canonicalOf(id)` follows: `id` and each later duplicate before the canonical
   * issue. Empty when `id` is its own canonical issue, isn't folded, or is on a duplicate cycle.
   */
  duplicateChain(id: string): readonly string[];
  /** Derived fields of a folded issue; `null` for an unfolded or missing one. */
  fields(id: string): DerivedFields | null;
  /** Edges of the effective `depends-on` graph, in neighbour order per source. */
  readonly dependsOn: readonly GraphEdge[];
  /** Edges of the `part-of` graph, in neighbour order per source. */
  readonly partOf: readonly GraphEdge[];
  /** Every qualifying component of both graphs: `depends-on` ones first, then by subject. */
  readonly cycles: readonly GraphCycle[];
}

const isLocal = (to: string) => !to.includes(":");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort(cmp);

/** Neighbour order: target id, raw before effective, via id. */
function compareEdges(a: GraphEdge, b: GraphEdge): number {
  if (a.to !== b.to) return cmp(a.to, b.to);
  if ((a.via === null) !== (b.via === null)) return a.via === null ? -1 : 1;
  return cmp(a.via ?? "", b.via ?? "");
}

/** Tarjan's strongly connected components of `nodes` (sorted) over `out`. */
function components(
  nodes: readonly string[],
  out: ReadonlyMap<string, readonly GraphEdge[]>,
): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const e of out.get(v) ?? []) {
      if (!index.has(e.to)) {
        visit(e.to);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(e.to) ?? 0));
      } else if (onStack.has(e.to)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(e.to) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      result.push(scc.sort(cmp));
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return result;
}

/** The first shortest cycle from `start` back to it inside `scc`, by BFS in neighbour order. */
function shortestCycle(
  start: string,
  scc: ReadonlySet<string>,
  out: ReadonlyMap<string, readonly GraphEdge[]>,
): GraphEdge[] {
  const via = new Map<string, GraphEdge>();
  const queue = [start];
  const seen = new Set([start]);
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i] as string;
    for (const e of out.get(v) ?? []) {
      if (!scc.has(e.to)) continue;
      if (e.to === start) {
        const path = [e];
        let cur = v;
        while (cur !== start) {
          const back = via.get(cur);
          if (back === undefined) break;
          path.unshift(back);
          cur = back.from;
        }
        return path;
      }
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      via.set(e.to, e);
      queue.push(e.to);
    }
  }
  return [];
}

/** The cycles of one graph: components of two or more nodes, or one node with a self-loop. */
function cyclesOf(
  rel: "depends-on" | "part-of",
  edges: readonly GraphEdge[],
  chainOf: (id: string) => readonly string[],
): GraphCycle[] {
  const out = new Map<string, GraphEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  for (const list of out.values()) list.sort(compareEdges);
  const nodes = sorted(edges.flatMap((e) => [e.from, e.to]));
  const found: GraphCycle[] = [];
  for (const scc of components(nodes, out)) {
    const [subject] = scc;
    if (subject === undefined) continue;
    const loop = (out.get(subject) ?? []).some((e) => e.to === subject);
    if (scc.length < 2 && !loop) continue;
    const members = new Set(scc);
    const through = edges.flatMap((e) =>
      e.via !== null && members.has(e.from) && members.has(e.to) ? chainOf(e.via) : [],
    );
    found.push({
      rel,
      subject,
      related: sorted([...scc.slice(1), ...through]).filter((id) => id !== subject),
      path: shortestCycle(subject, new Set(scc), out),
    });
  }
  return found.sort((a, b) => cmp(a.subject, b.subject));
}

/** `depends-on cycle: A → C (via duplicate B) → A`. */
export function cycleMessage(c: GraphCycle): string {
  const steps = c.path.map((e) => ` → ${e.to}${e.via === null ? "" : ` (via duplicate ${e.via})`}`);
  return `${c.rel} cycle: ${c.subject}${steps.join("")}`;
}

function build(log: Log): IssueGraph {
  const folded = new Map<string, Subject>();
  for (const [id, s] of log.subjects) if (s.status !== null && s.state !== null) folded.set(id, s);
  const state = (id: string) => folded.get(id)?.state ?? null;
  const isDuplicate = (id: string) => {
    const s = folded.get(id);
    return s?.status === "closed" && s.state?.resolution === "duplicate";
  };

  const canonical = new Map<string, string | null>();
  const canonicalOf = (id: string): string | null => {
    const known = canonical.get(id);
    if (known !== undefined) return known;
    const seen = [id];
    let cur = id;
    let result: string | null;
    for (;;) {
      const next = isDuplicate(cur) ? (state(cur)?.duplicateOf ?? null) : null;
      if (next === null || !folded.has(next)) {
        result = cur;
        break;
      }
      if (seen.includes(next)) {
        result = null;
        break;
      }
      seen.push(next);
      cur = next;
    }
    canonical.set(id, result);
    return result;
  };

  const chainOf = (id: string): string[] => {
    const c = canonicalOf(id);
    if (c === null || c === id) return [];
    const chain: string[] = [];
    for (let cur: string | null = id; cur !== null && cur !== c; ) {
      chain.push(cur);
      cur = state(cur)?.duplicateOf ?? null;
    }
    return chain;
  };

  const targets = (id: string, rel: Rel) =>
    (state(id)?.links ?? []).filter((l) => l.rel === rel).map((l) => l.to);

  const dependsOn: GraphEdge[] = [];
  const partOf: GraphEdge[] = [];
  const blocks = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const duplicates = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, key: string, value: string) =>
    m.set(key, [...(m.get(key) ?? []), value]);
  for (const [x, s] of folded) {
    const st = s.state as IssueState;
    for (const link of st.links) {
      if (!isLocal(link.to) || link.to === x || !folded.has(link.to)) continue;
      if (link.rel === "depends-on") {
        dependsOn.push({ from: x, to: link.to, via: null, event: link.event });
        push(blocks, link.to, x);
        const c = isDuplicate(link.to) ? canonicalOf(link.to) : null;
        if (c !== null && c !== link.to) {
          dependsOn.push({ from: x, to: c, via: link.to, event: link.event });
        }
      } else if (link.rel === "part-of") {
        partOf.push({ from: x, to: link.to, via: null, event: link.event });
        push(children, link.to, x);
      }
    }
    if (isDuplicate(x) && st.duplicateOf !== null && st.duplicateOf !== x) {
      push(duplicates, st.duplicateOf, x);
    }
  }

  const fields = new Map<string, DerivedFields>();
  const fieldsOf = (id: string): DerivedFields | null => {
    const known = fields.get(id);
    if (known !== undefined) return known;
    const s = folded.get(id);
    if (s === undefined || s.status === null || s.state === null) return null;
    const st = s.state;
    const status = s.status;
    const dependsOnIds = sorted(targets(id, "depends-on"));
    const blockedByOpen = sorted(
      dependsOnIds.flatMap((t) => {
        if (!isLocal(t) || !folded.has(t)) return [];
        const c = canonicalOf(t) ?? t;
        return c === id || folded.get(c)?.status === "closed" ? [] : [c];
      }),
    );
    const blocked = status !== "closed" && blockedByOpen.length > 0;
    const kids = sorted(children.get(id) ?? []);
    const openChild = kids.some((k) => folded.get(k)?.status !== "closed");
    const parent = st.links.find((l) => l.rel === "part-of")?.to ?? null;
    const f: DerivedFields = {
      depends_on: dependsOnIds,
      blocks: sorted(blocks.get(id) ?? []),
      blocked_by_open: blockedByOpen,
      blocked,
      parent,
      children: kids,
      relates_to: sorted(targets(id, "relates-to")),
      implements: sorted(targets(id, "implements")),
      duplicates: sorted(duplicates.get(id) ?? []),
      canonical: canonicalOf(id),
      ready: status === "open" && !blocked && st.assignees.length === 0 && !openChild,
    };
    fields.set(id, f);
    return f;
  };

  return {
    canonicalOf: (id) => (folded.has(id) ? canonicalOf(id) : null),
    duplicateChain: (id) => (folded.has(id) ? chainOf(id) : []),
    fields: fieldsOf,
    dependsOn,
    partOf,
    cycles: [
      ...cyclesOf("depends-on", dependsOn, chainOf),
      ...cyclesOf("part-of", partOf, chainOf),
    ],
  };
}

const graphs = new WeakMap<object, IssueGraph>();

/**
 * The relation graph and derived fields of a folded issue log: current links of folded subjects,
 * local edges only. Built once per `FoldedLog` object, so projecting every issue is O(n + edges).
 */
export function issueGraph(log: Log): IssueGraph {
  const known = graphs.get(log);
  if (known !== undefined) return known;
  const g = build(log);
  graphs.set(log, g);
  return g;
}
