/**
 * Test-only reference model of an issue log (design "Oracle"): a hand-written replay with its own
 * transition table, its own canonical issues and its own strongly connected components. It never
 * imports kind/graph.ts or the kind's rules, so a bug there can't hide in both.
 */
import type { EventEnvelope } from "@nikovirtala/ledger";

type Step = { readonly subject: string; readonly path: string; readonly event: EventEnvelope };
type State = "open" | "in-progress" | "closed";
/** The design's state machine: the state an event leads to, `"same"`, or absent when illegal. */
const NEXT: Readonly<Record<State, Readonly<Record<string, State | "same">>>> = {
  open: {
    started: "in-progress",
    closed: "closed",
    assigned: "same",
    labeled: "same",
    commented: "same",
    linked: "same",
    unlinked: "same",
    scoped: "same",
  },
  "in-progress": {
    stopped: "open",
    closed: "closed",
    assigned: "same",
    labeled: "same",
    commented: "same",
    linked: "same",
    unlinked: "same",
    scoped: "same",
  },
  closed: {
    reopened: "open",
    assigned: "same",
    labeled: "same",
    commented: "same",
    linked: "same",
    unlinked: "same",
    scoped: "same",
  },
};

/** One issue of the reference model. */
export interface Model {
  state: State;
  resolution: string | null;
  links: { to: string; rel: string }[];
  duplicateOf: string | null;
  labels: string[];
  assignees: string[];
  appliesTo: string[];
}

/** Tarjan's components, written again for the oracle. */
function sccs(nodes: readonly string[], out: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const result: string[][] = [];
  let n = 0;
  const strong = (v: string): void => {
    index.set(v, n);
    low.set(v, n);
    n++;
    stack.push(v);
    for (const w of out.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (stack.includes(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const c: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w !== undefined) c.push(w);
      } while (w !== undefined && w !== v);
      result.push(c.sort());
    }
  };
  for (const v of nodes) if (!index.has(v)) strong(v);
  return result;
}

/** The reference model's issues after `steps`, and the error lines verify must report. */
export function referenceModel(
  steps: readonly Step[],
  o: { readonly exclusive?: readonly string[] } = {},
): { models: Map<string, Model>; lines: string[] } {
  const lines: string[] = [];
  const bySubject = new Map<string, EventEnvelope[]>();
  for (const { event } of steps) {
    bySubject.set(event.subject, [...(bySubject.get(event.subject) ?? []), event]);
  }
  const models = new Map<string, Model>();
  for (const [subject, events] of bySubject) {
    const ordered = [...events].sort((a, b) =>
      a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    let m: Model | null = null;
    for (const e of ordered) {
      if (m === null) {
        const parent = e.data.parent;
        m = {
          state: "open",
          resolution: null,
          links: typeof parent === "string" ? [{ to: parent, rel: "part-of" }] : [],
          duplicateOf: null,
          labels: [],
          assignees: [],
          appliesTo: [],
        };
        continue;
      }
      const next = NEXT[m.state][e.type];
      if (next === undefined) {
        lines.push(`transition/illegal ${subject}`);
        continue;
      }
      if (next !== "same") m.state = next;
      const to = String(e.data.to ?? "");
      const rel = String(e.data.rel ?? "");
      if (e.type === "closed") {
        m.resolution = String(e.data.resolution);
        m.duplicateOf = e.data.resolution === "duplicate" ? String(e.data.of) : null;
        if (m.resolution !== "done" && String(e.reason ?? "").trim() === "") {
          lines.push(`issue/reason-required ${subject}`);
        }
      }
      if (e.type === "reopened") {
        m.resolution = null;
        m.duplicateOf = null;
      }
      if (e.type === "labeled") m.labels = [...(e.data.set as string[])];
      if (e.type === "assigned") m.assignees = [...(e.data.set as string[])];
      if (e.type === "scoped") m.appliesTo = [...(e.data.set as string[])];
      if (e.type === "linked" && !m.links.some((l) => l.to === to && l.rel === rel)) {
        m.links.push({ to, rel });
      }
      if (e.type === "unlinked") m.links = m.links.filter((l) => !(l.to === to && l.rel === rel));
    }
    if (m !== null) models.set(subject, m);
  }
  const dup = (id: string) => {
    const m = models.get(id);
    return m !== undefined && m.state === "closed" && m.duplicateOf !== null ? m.duplicateOf : null;
  };
  const canonical = (id: string): string | null => {
    const seen = [id];
    let cur = id;
    for (;;) {
      const next = dup(cur);
      if (next === null || !models.has(next)) return cur;
      if (seen.includes(next)) return null;
      seen.push(next);
      cur = next;
    }
  };
  const dependsOn = new Map<string, string[]>();
  const partOf = new Map<string, string[]>();
  const loops = new Set<string>();
  for (const [x, m] of models) {
    for (const l of m.links) {
      if (l.to === x || !models.has(l.to)) continue;
      if (l.rel === "depends-on") {
        dependsOn.set(x, [...(dependsOn.get(x) ?? []), l.to]);
        const c = dup(l.to) === null ? null : canonical(l.to);
        if (c !== null && c !== l.to) {
          dependsOn.set(x, [...(dependsOn.get(x) ?? []), c]);
          if (c === x) loops.add(x);
        }
      }
      if (l.rel === "part-of") partOf.set(x, [...(partOf.get(x) ?? []), l.to]);
    }
  }
  const nodes = [...models.keys()].sort();
  for (const [graph, selfLoops] of [
    [dependsOn, loops],
    [partOf, new Set<string>()],
  ] as const) {
    for (const c of sccs(nodes, graph)) {
      const [first] = c;
      if (first !== undefined && (c.length > 1 || selfLoops.has(first))) {
        lines.push(`issue/cycle ${first}`);
      }
    }
  }
  for (const [x, m] of models) {
    const of = dup(x);
    if (of !== null && of !== x && dup(of) !== null)
      lines.push(`issue/duplicate-of-duplicate ${x}`);
    if (m.links.filter((l) => l.rel === "part-of").length > 1) {
      lines.push(`issue/multiple-parents ${x}`);
    }
  }
  for (const [x, m] of models) {
    const prefixes = m.labels
      .filter((l) => l.includes(":"))
      .map((l) => l.slice(0, l.indexOf(":")))
      .filter((p) => (o.exclusive ?? []).includes(p));
    for (const p of new Set(prefixes)) {
      if (prefixes.filter((q) => q === p).length > 1) lines.push(`issue/label-exclusive ${x}`);
    }
  }
  return { models, lines: lines.sort() };
}

/** The sorted `<rule> <subject>` error lines verify must report for `steps`. */
export function referenceLines(
  steps: readonly Step[],
  o: { readonly exclusive?: readonly string[] } = {},
): string[] {
  return referenceModel(steps, o).lines;
}
