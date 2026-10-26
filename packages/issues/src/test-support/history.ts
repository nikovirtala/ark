/**
 * Test-only generators of issue histories (design "Generators and their preconditions"). Each
 * generator states its preconditions as guarantees about what it returns, and
 * `generators.test.ts` samples it and asserts them.
 */
import {
  type Check,
  type EventEnvelope,
  foldChecks,
  parseTemplate,
  renderTemplate,
  serializeEvent,
  type Template,
  treeTemplates,
} from "@nikovirtala/ledger";
import {
  arbLegalHistory,
  type DataArbs,
  type HistoryContext,
  type LegalHistory,
} from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { type IssueOptions, type IssueState, issueKind, labelPrefix } from "../kind.js";
import { TASK_V1 } from "../templates/builtin.js";
import {
  ASSIGNEE_POOL,
  arbReason,
  arbTitle,
  GLOB_POOL,
  ISSUE_TEST_OPTIONS,
  LABEL_POOL,
} from "./arbitraries.js";

export type IssueKind = typeof issueKind;
export type IssueHistory = LegalHistory<IssueKind>;

export const HISTORY_LAYOUT = issueKind.layoutAt("docs/issues");
export const TEMPLATE_PATH = "docs/issues/templates/task.md";

const encoder = new TextEncoder();
const parsedTask = parseTemplate(TASK_V1, { path: TEMPLATE_PATH });
if (!parsedTask.ok) throw new Error("the built-in task template doesn't parse");
export const TASK_TEMPLATE: Template = parsedTask.template;

/** Every check `verify` runs on a MemoryTree, with the templates of the head tree. */
export function issueChecks(options: IssueOptions = ISSUE_TEST_OPTIONS): readonly Check[] {
  return foldChecks(issueKind, {
    options,
    templates: (head, dir) => treeTemplates(head, dir),
  });
}

/** How `issueDataArbs` weights its choices. */
export interface DataWeights {
  /** Prefer `depends-on` and `part-of` links (default `false`). */
  readonly links?: boolean;
  /** Prefer closing as a duplicate when it is legal (default `false`). */
  readonly duplicates?: boolean;
  /** `implements` targets, as stored (`adr:<id>`); none by default. */
  readonly decisions?: readonly string[];
}

/** What the generators know about the subjects so far. */
export interface Graphs {
  readonly subjects: readonly string[];
  status(id: string): string | null;
  state(id: string): IssueState | null;
}

const isLocal = (to: string) => !to.includes(":");

export const isDuplicate = (g: Graphs, id: string) =>
  g.status(id) === "closed" && g.state(id)?.resolution === "duplicate";

/** `canonical`: follows current duplicates to the last created issue; `null` on a cycle. */
export function canonicalIn(g: Graphs, id: string): string | null {
  const seen = [id];
  let cur = id;
  for (;;) {
    const next = isDuplicate(g, cur) ? (g.state(cur)?.duplicateOf ?? null) : null;
    if (next === null || g.status(next) === null) return cur;
    if (seen.includes(next)) return null;
    seen.push(next);
    cur = next;
  }
}

/** Out-neighbours in the effective `depends-on` graph (design `issue/cycle`). */
export function dependsOnEdges(g: Graphs, x: string): string[] {
  const out: string[] = [];
  for (const l of g.state(x)?.links ?? []) {
    if (l.rel !== "depends-on" || !isLocal(l.to) || l.to === x || g.status(l.to) === null) continue;
    out.push(l.to);
    if (isDuplicate(g, l.to)) {
      const c = canonicalIn(g, l.to);
      if (c !== null && c !== l.to) out.push(c);
    }
  }
  return out;
}

/** Out-neighbours in the `part-of` graph. */
export function partOfEdges(g: Graphs, x: string): string[] {
  return (g.state(x)?.links ?? [])
    .filter((l) => l.rel === "part-of" && isLocal(l.to) && l.to !== x && g.status(l.to) !== null)
    .map((l) => l.to);
}

/** Whether a path of length ≥ 1 leads from `from` to `to`. */
export function reaches(
  next: (id: string) => readonly string[],
  from: string,
  to: string,
): boolean {
  const queue = [...next(from)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const v = queue.shift() as string;
    if (v === to) return true;
    if (seen.has(v)) continue;
    seen.add(v);
    queue.push(...next(v));
  }
  return false;
}

const graphsOf = (ctx: HistoryContext): Graphs => ({
  subjects: ctx.subjects,
  status: (id) => ctx.status(id),
  state: (id) => ctx.state(id) as IssueState | null,
});

/** The duplicate targets `subject` may be closed as a duplicate of (design `closed` row). */
export function duplicateTargets(g: Graphs, subject: string): string[] {
  if (
    g.subjects.some(
      (y) => y !== subject && isDuplicate(g, y) && g.state(y)?.duplicateOf === subject,
    )
  ) {
    return [];
  }
  const dependents = g.subjects.filter((x) =>
    (g.state(x)?.links ?? []).some(
      (l) => l.rel === "depends-on" && l.to === subject && x !== subject,
    ),
  );
  const deps = (id: string) => dependsOnEdges(g, id);
  return g.subjects.filter(
    (t) =>
      t !== subject &&
      g.status(t) !== null &&
      !isDuplicate(g, t) &&
      !dependents.includes(t) &&
      dependents.every((x) => !reaches(deps, t, x)),
  );
}

/** The `(to, rel)` pairs `subject` may link to now (design `linked` row). */
export function linkCandidates(
  g: Graphs,
  subject: string,
  decisions: readonly string[] = [],
): { to: string; rel: "depends-on" | "part-of" | "relates-to" | "implements" }[] {
  const current = g.state(subject)?.links ?? [];
  const has = (to: string, rel: string) => current.some((l) => l.to === to && l.rel === rel);
  const out: ReturnType<typeof linkCandidates> = [];
  const deps = (id: string) => dependsOnEdges(g, id);
  const parts = (id: string) => partOfEdges(g, id);
  const hasParent = current.some((l) => l.rel === "part-of");
  for (const to of g.subjects) {
    if (to === subject) continue;
    if (!has(to, "depends-on")) {
      const c = canonicalIn(g, to);
      if (
        c !== null &&
        c !== subject &&
        !reaches(deps, to, subject) &&
        !reaches(deps, c, subject)
      ) {
        out.push({ to, rel: "depends-on" });
      }
    }
    if (!hasParent && !has(to, "part-of") && !reaches(parts, to, subject)) {
      out.push({ to, rel: "part-of" });
    }
    if (!has(to, "relates-to")) out.push({ to, rel: "relates-to" });
  }
  for (const d of decisions) if (!has(d, "implements")) out.push({ to: d, rel: "implements" });
  return out;
}

/** At most one label per exclusive prefix of `options`. */
const exclusiveLabels = (options: IssueOptions) =>
  fc.uniqueArray(fc.constantFrom(...LABEL_POOL), { maxLength: 4 }).map((labels) => {
    const seen = new Set<string>();
    const exclusive = new Set(options.exclusive);
    return labels
      .filter((l) => {
        const p = labelPrefix(l);
        if (p === null || !exclusive.has(p)) return true;
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      })
      .sort();
  });

/**
 * Data for `arbLegalHistory(issueKind, …)`: every entry returns `null` when no legal data exists,
 * so generated histories verify clean under `options` (default `ISSUE_TEST_OPTIONS`).
 */
export function issueDataArbs(
  o: DataWeights & { readonly options?: IssueOptions } = {},
): DataArbs<IssueKind> {
  const options = o.options ?? ISSUE_TEST_OPTIONS;
  return {
    opened: (ctx) => {
      const parents = ctx.subjects.filter((id) => id !== ctx.subject);
      const parent =
        parents.length === 0
          ? fc.constant(undefined)
          : fc.oneof(
              { arbitrary: fc.constant(undefined), weight: 7 },
              { arbitrary: fc.constantFrom(...parents), weight: 3 },
            );
      return fc.record({ title: arbTitle, parent }).map(({ title, parent }) => ({
        title,
        template: "task",
        template_version: 1,
        ...(parent === undefined ? {} : { parent }),
      }));
    },
    started: () => fc.constant({}),
    stopped: () => fc.constant({}),
    reopened: () => fc.constant({}),
    closed: (ctx) => {
      const targets = duplicateTargets(graphsOf(ctx), ctx.subject);
      const plain = fc
        .constantFrom("done" as const, "wontfix" as const, "obsolete" as const)
        .map((resolution) => ({ resolution }));
      if (targets.length === 0) return plain;
      const duplicate = fc
        .constantFrom(...targets)
        .map((of) => ({ resolution: "duplicate" as const, of }));
      return o.duplicates === true
        ? fc.oneof({ arbitrary: duplicate, weight: 3 }, { arbitrary: plain, weight: 1 })
        : fc.oneof(plain, duplicate);
    },
    assigned: () =>
      fc.uniqueArray(fc.constantFrom(...ASSIGNEE_POOL), { maxLength: 3 }).map((set) => ({
        set: set.sort(),
      })),
    labeled: () => exclusiveLabels(options).map((set) => ({ set })),
    commented: () => fc.record({ text: fc.string({ minLength: 1, maxLength: 40 }) }),
    linked: (ctx) => {
      const all = linkCandidates(graphsOf(ctx), ctx.subject, o.decisions ?? []);
      if (all.length === 0) return null;
      const strong = all.filter((c) => c.rel === "depends-on" || c.rel === "part-of");
      if (o.links === true && strong.length > 0) {
        return fc.oneof(
          { arbitrary: fc.constantFrom(...strong), weight: 4 },
          { arbitrary: fc.constantFrom(...all), weight: 1 },
        );
      }
      return fc.constantFrom(...all);
    },
    unlinked: (ctx) => {
      const links = (ctx.state(ctx.subject) as IssueState | null)?.links ?? [];
      return links.length === 0
        ? null
        : fc.constantFrom(...links).map((l) => ({ to: l.to, rel: l.rel }));
    },
    scoped: () =>
      fc.uniqueArray(fc.constantFrom(...GLOB_POOL), { maxLength: 3 }).map((set) => ({
        set: set.sort(),
      })),
  };
}

/** Section text for generated bodies: 1–40 characters of `[a-z ]`, trimmed non-empty. */
export const arbSectionText: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z ]{1,40}$/)
  .map((s) => s.trim())
  .filter((s) => s !== "");

/** The rendered `task` body of an issue titled `title`. */
export function taskBody(
  title: string,
  sections: { readonly goal: string; readonly done: string; readonly notes?: string },
): string {
  const r = renderTemplate(TASK_TEMPLATE, { title, sections: { ...sections } });
  if (!r.ok) throw new Error(`can't render a task body for ${JSON.stringify(title)}`);
  return r.text;
}

export const arbTaskSections = fc.record(
  { goal: arbSectionText, done: arbSectionText, notes: arbSectionText },
  { requiredKeys: ["goal", "done"] },
);

/** `h` with `event` replaced everywhere it is held: `files`, `subjects` and `steps`. */
export function replaceEvent(h: IssueHistory, path: string, event: EventEnvelope): IssueHistory {
  return {
    ...h,
    files: { ...h.files, [path]: serializeEvent(event) },
    subjects: h.subjects.map((s) => ({
      ...s,
      events: s.events.map((e) => (e.path === path ? { path, event } : e)),
    })),
    steps: h.steps.map((s) => (s.path === path ? { ...s, event } : s)),
  };
}

/**
 * Legal issue histories under `docs/issues` (design "Shared fixture rules"): unique ids, the
 * built-in `task` template in `files`, each body the rendered `task` template with its `opened`
 * title, a reason on every `closed` event, and data from `issueDataArbs`, so every history
 * verifies with no error under `ISSUE_TEST_OPTIONS`.
 */
export function arbIssueHistory(
  o: DataWeights & {
    readonly subjects?: { readonly min: number; readonly max: number };
    readonly maxSteps?: number;
    readonly options?: IssueOptions;
    readonly actor?: fc.Arbitrary<EventEnvelope["actor"]>;
  } = {},
): fc.Arbitrary<IssueHistory> {
  const base = arbLegalHistory(issueKind, {
    layout: HISTORY_LAYOUT,
    data: issueDataArbs(o),
    body: () => fc.constant(""),
    files: { [TEMPLATE_PATH]: TASK_V1 },
    ...(o.subjects === undefined ? {} : { subjects: o.subjects }),
    ...(o.maxSteps === undefined ? {} : { maxSteps: o.maxSteps }),
    ...(o.actor === undefined ? {} : { actor: o.actor }),
  });
  return base.chain((h) => {
    const closings = h.steps.filter((s) => s.event.type === "closed").map((s) => s.path);
    return fc
      .record({
        sections: fc.array(arbTaskSections, {
          minLength: h.subjects.length,
          maxLength: h.subjects.length,
        }),
        reasons: fc.array(arbReason, { minLength: closings.length, maxLength: closings.length }),
      })
      .map(({ sections, reasons }) => {
        let out: IssueHistory = h;
        closings.forEach((path, i) => {
          const step = out.steps.find((s) => s.path === path);
          if (step === undefined) return;
          out = replaceEvent(out, path, { ...step.event, reason: reasons[i] ?? "done" });
        });
        const files = { ...out.files };
        out.subjects.forEach((s, i) => {
          const title = s.events.find((e) => e.event.type === "opened")?.event.data.title;
          if (s.bodyPath === null || typeof title !== "string") return;
          files[s.bodyPath] = taskBody(title, sections[i] ?? { goal: "goal", done: "done" });
        });
        return { ...out, files };
      });
  });
}

/** `files` as the bytes a MemoryTree takes. */
export const bytesOf = (files: Readonly<Record<string, string>>): Record<string, Uint8Array> =>
  Object.fromEntries(Object.entries(files).map(([p, t]) => [p, encoder.encode(t)]));

/** The final statuses and states of `h`, replayed from its steps. */
export function finalGraphs(h: IssueHistory): Graphs {
  const status = new Map<string, string>();
  const state = new Map<string, IssueState>();
  const order: string[] = [];
  for (const { event } of h.steps) {
    if (!status.has(event.subject)) order.push(event.subject);
    const to = issueKind.machine.types.get(event.type)?.to ?? status.get(event.subject);
    if (to !== undefined) status.set(event.subject, to);
    state.set(
      event.subject,
      issueKind.def.reduce(state.get(event.subject) ?? null, event as never),
    );
  }
  return {
    subjects: order,
    status: (id) => status.get(id) ?? null,
    state: (id) => state.get(id) ?? null,
  };
}
