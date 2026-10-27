import type { FoldedLog, FoldedSubject, KindFinding } from "@nikovirtala/ledger";
import { cycleMessage, issueGraph } from "./graph.js";
import type { IssueState } from "./reduce.js";
import type { IssueEvents, IssueStatus } from "./schemas.js";

/** One subject of another log that references can name. */
export interface ForeignSubject {
  /** The source kind's state or status. */
  readonly status: string;
  /** `ADR-0007`, `?42` or the id. */
  readonly display: string;
  readonly title: string;
  /** Decisions: the decision in force; issues: the canonical issue. */
  readonly effective: string | null;
}

/** Another log that qualified references (`<source>:<id>`) can name. */
export interface SourceLog {
  readonly kind: "issues" | "adr";
  /** The repository's own decision log (`adr`), always read. */
  readonly local: boolean;
  /** Known subjects; `null` when the log isn't read, so references into it aren't checked. */
  readonly subjects: ReadonlyMap<string, ForeignSubject> | null;
  /** A `[[sources]]` entry's cached commit; `null` for the local log or an uncached source. */
  readonly commit?: string | null;
}

/** Options of the issue kind's `invariants` and `relate` (`issues.toml`, plus the sources read). */
export interface IssueOptions {
  /** `[policy] close_requires_human`, default `false`. */
  readonly closeRequiresHuman: boolean;
  /** `[policy] mcp_can_close`, default `true`: whether agents may close issues at all. */
  readonly mcpCanClose: boolean;
  /** `[labels] exclusive`: label prefixes an issue can hold only one label of. */
  readonly exclusive: readonly string[];
  /** Other logs references can name; `null`: not read, so qualified references aren't checked. */
  readonly sources: ReadonlyMap<string, SourceLog> | null;
}

export const DEFAULT_ISSUE_OPTIONS: IssueOptions = Object.freeze({
  closeRequiresHuman: false,
  mcpCanClose: true,
  exclusive: Object.freeze([]) as readonly string[],
  sources: null,
});

type Subject = FoldedSubject<IssueStatus, IssueState, IssueEvents>;
type Log = FoldedLog<IssueStatus, IssueState, IssueEvents>;

/** The part of a label before its first `:`, or `null` without one. */
export function labelPrefix(label: string): string | null {
  const at = label.indexOf(":");
  return at < 0 ? null : label.slice(0, at);
}

const blank = (reason: string | null | undefined) =>
  reason === undefined || reason === null || reason.trim() === "";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort(cmp);
const RESOLUTION_WORDS: Readonly<Record<string, string>> = {
  done: "done",
  wontfix: "won't fix",
  duplicate: "a duplicate",
  obsolete: "obsolete",
};

/**
 * Per-subject rules (errors): every applied `closed` event's reason, `of` and agent policy; a
 * current link (or `closed.of`) naming the subject itself; and an exclusive label prefix held
 * twice in the current label set.
 */
export function invariants(subject: Subject, options: IssueOptions): readonly KindFinding[] {
  const out: KindFinding[] = [];
  const id = subject.id;
  const add = (rule: string, message: string, event: string) =>
    out.push({ severity: "error", rule, message, subject: id, event });

  for (const { event } of subject.applied) {
    if (event.type !== "closed") continue;
    const { resolution, of } = event.data;
    const as = RESOLUTION_WORDS[resolution] ?? resolution;
    if (resolution !== "done" && blank(event.reason)) {
      add("issue/reason-required", `closed as ${as} without a reason`, event.id);
    }
    if (of !== undefined && resolution !== "duplicate") {
      add(
        "issue/of-without-duplicate",
        `closed as ${as} with of ${of}; of is only for duplicates`,
        event.id,
      );
    }
    if (of !== undefined && of === id) {
      add("issue/self-reference", "closed as a duplicate of itself", event.id);
    }
    if (event.actor.kind === "agent") {
      const agent = event.actor.agent ?? event.actor.name;
      if (options.closeRequiresHuman || !options.mcpCanClose) {
        const key = options.closeRequiresHuman
          ? "close_requires_human = true needs a human"
          : "mcp_can_close = false forbids agent closes";
        add("issue/agent-closed", `closed as ${as} by agent ${agent}; ${key}`, event.id);
      }
      if (blank(event.reason)) {
        add(
          "issue/agent-reason-required",
          `closed as ${as} by agent ${agent} without a reason; an agent must say how the issue was done`,
          event.id,
        );
      }
    }
  }

  const state = subject.state;
  if (state !== null) {
    for (const link of state.links) {
      if (link.to === id) add("issue/self-reference", `${link.rel} links to itself`, link.event);
    }
    const exclusive = new Set(options.exclusive);
    const labeled = subject.applied.findLast((a) => a.event.type === "labeled")?.event.id;
    if (exclusive.size > 0 && labeled !== undefined) {
      const byPrefix = new Map<string, string[]>();
      for (const label of state.labels) {
        const p = labelPrefix(label);
        if (p !== null && exclusive.has(p)) byPrefix.set(p, [...(byPrefix.get(p) ?? []), label]);
      }
      for (const [prefix, labels] of [...byPrefix].sort(([a], [b]) => cmp(a, b))) {
        if (labels.length < 2) continue;
        add(
          "issue/label-exclusive",
          `labels ${sorted(labels).join(", ")} share the exclusive prefix ${prefix}`,
          labeled,
        );
      }
    }
  }
  return out;
}

/** The subject's current `closed` event id, when it is closed. */
function currentClosed(s: Subject): string | undefined {
  if (s.status !== "closed") return undefined;
  return s.applied.findLast((a) => a.event.type === "closed")?.event.id;
}

/**
 * Cross-subject rules over the whole log: missing references, unknown sources, target kinds,
 * duplicates of duplicates, cycles (one per strongly connected component), multiple parents
 * (errors), and `implements` to an unaccepted decision and closing with open work (warnings).
 */
export function relate(log: Log, options: IssueOptions): readonly KindFinding[] {
  const out: KindFinding[] = [];
  const graph = issueGraph(log);
  const push = (
    severity: "error" | "warning",
    rule: string,
    subject: string,
    message: string,
    event: string | undefined,
    related: readonly string[],
  ) =>
    out.push({
      severity,
      rule,
      message,
      subject,
      ...(event === undefined ? {} : { event }),
      ...(related.length === 0 ? {} : { related }),
    });

  /** A local reference: missing, or present without folded state. */
  const local = (id: string, ref: string, what: string, event: string) => {
    const target = log.subjects.get(ref);
    if (target !== undefined && target.status !== null) return;
    const why =
      target === undefined ? "which is not in the log" : "which has no valid opened event";
    push("error", "issue/reference-missing", id, `${what} ${ref}, ${why}`, event, [ref]);
  };

  for (const [id, s] of log.subjects) {
    const st = s.state;
    if (s.status === null || st === null) continue;
    for (const link of st.links) {
      const { to, rel } = link;
      const at = to.indexOf(":");
      if (at < 0) {
        if (to === id) continue;
        if (rel === "implements") {
          push(
            "error",
            "issue/target-kind",
            id,
            `implements ${to}: implements needs a decision, and ${to} is an issue`,
            link.event,
            [to],
          );
          continue;
        }
        local(id, to, rel, link.event);
        continue;
      }
      if (options.sources === null) continue;
      const name = to.slice(0, at);
      const target = to.slice(at + 1);
      const source = options.sources.get(name);
      if (source === undefined) {
        push(
          "error",
          "issue/unknown-source",
          id,
          name === "adr"
            ? `${rel} ${to}: no decision log in this repository (docs/adr)`
            : `${rel} ${to}: unknown source ${name}; add a [[sources]] entry named ${name}`,
          link.event,
          [],
        );
        continue;
      }
      const wants = rel === "implements" ? "adr" : "issues";
      if (source.kind !== wants) {
        const needs = rel === "implements" ? "a decision" : "an issue";
        const is = source.kind === "adr" ? "a decision" : "an issue";
        push(
          "error",
          "issue/target-kind",
          id,
          `${rel} ${to}: ${rel} needs ${needs}, and ${to} is ${is}`,
          link.event,
          [],
        );
        continue;
      }
      if (source.subjects === null) continue;
      const found = source.subjects.get(target);
      if (found === undefined) {
        push(
          "error",
          "issue/reference-missing",
          id,
          `${rel} ${to}, which is not in source ${name}`,
          link.event,
          [],
        );
        continue;
      }
      if (rel === "implements" && found.status !== "accepted") {
        const effective =
          found.status === "superseded" && found.effective !== null && found.effective !== target
            ? `; the decision in force is ${name}:${found.effective}`
            : "";
        push(
          "warning",
          "issue/implements-unaccepted",
          id,
          `implements ${to}, which is ${found.status}${effective}`,
          link.event,
          [],
        );
      }
    }

    const closed = currentClosed(s);
    if (closed !== undefined && st.duplicateOf !== null && st.duplicateOf !== id) {
      const of = st.duplicateOf;
      local(id, of, "duplicate of", closed);
      const target = log.subjects.get(of);
      const next = target?.state?.duplicateOf ?? null;
      if (
        target?.status === "closed" &&
        target.state?.resolution === "duplicate" &&
        next !== null
      ) {
        push(
          "error",
          "issue/duplicate-of-duplicate",
          id,
          `duplicate of ${of}, which is itself a duplicate of ${next}; close ${id} as a duplicate of ${next}`,
          closed,
          [of],
        );
      }
    }

    const parents = st.links.filter((l) => l.rel === "part-of" && l.to !== id);
    if (parents.length > 1) {
      const latest = parents[parents.length - 1];
      const names = sorted(parents.map((l) => l.to));
      push(
        "error",
        "issue/multiple-parents",
        id,
        `part of more than one issue: ${names.join(", ")}`,
        latest?.event,
        names.filter((n) => !n.includes(":")),
      );
    }

    if (closed !== undefined) {
      const f = graph.fields(id);
      const open = (f?.children ?? []).filter((c) => log.subjects.get(c)?.status !== "closed");
      if (open.length > 0) {
        push(
          "warning",
          "issue/closed-with-open-children",
          id,
          `closed while its children ${open.join(", ")} are not closed`,
          closed,
          open,
        );
      }
      const blockers = f?.blocked_by_open ?? [];
      if (st.resolution === "done" && blockers.length > 0) {
        // The duplicates a dependency follows to an open blocker cause the warning too.
        const through = (f?.depends_on ?? []).flatMap((t) => {
          const c = graph.canonicalOf(t);
          return c !== null && blockers.includes(c) ? graph.duplicateChain(t) : [];
        });
        push(
          "warning",
          "issue/closed-with-open-dependencies",
          id,
          `closed as done while it depends on ${blockers.join(", ")}, which are not closed`,
          closed,
          sorted([...blockers, ...through]),
        );
      }
    }
  }

  for (const c of graph.cycles) {
    push("error", "issue/cycle", c.subject, cycleMessage(c), c.path[0]?.event, c.related);
  }
  return out;
}
