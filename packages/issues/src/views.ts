import {
  type Actor,
  compareEvents,
  type EventEnvelope,
  type Finding,
  type StateHeader,
  UsageError,
} from "@nikovirtala/ledger";
import type { IssueStatus, IssueView, Rel } from "./kind.js";
import { type IssuesRead, readNotes } from "./log.js";

/** The `numbering` key of the read documents. */
export interface NumberingJson {
  readonly available: boolean;
  readonly reason: "shallow" | "no-main-ref" | "index" | null;
  readonly ref: string | null;
}

/** `issues list --json`. */
export interface IssueListJson {
  readonly format: "issues-list/v1";
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  /** `null`: this repository's log (always, in this version). */
  readonly source: string | null;
  readonly filter: {
    readonly states: readonly IssueStatus[];
    readonly assignees: readonly string[];
    readonly labels: readonly string[];
    readonly limit: number | null;
  };
  readonly issues: readonly IssueView[];
  /** Newer envelope or schema versions; upgrade issues. */
  readonly unreadable: readonly string[];
  /** First event not `opened`, or a body with no events; run issues verify. */
  readonly unfoldable: readonly string[];
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

/** One relation target of an issue, resolved for display. */
export interface IssueReference {
  readonly rel: Rel | "parent" | "child" | "blocks" | "duplicate-of" | "duplicate";
  /** As stored: a local id, `adr:<id>`, `<source>:<id>`. */
  readonly to: string;
  /** `?17`, `ADR-0007`, or `to`. */
  readonly display: string;
  readonly title: string | null;
  /** The target's state or decision status; `null` when unknown. */
  readonly status: string | null;
  /** `false` for references into other repositories, which this version doesn't read. */
  readonly checked: boolean;
}

/** One applied `commented` event, in fold order. */
export interface IssueCommentJson {
  /** The event id. */
  readonly id: string;
  readonly at: string;
  readonly actor: Actor;
  readonly text: string;
}

/** A commit with an `Issue:` trailer naming the issue. */
export interface IssueCommitJson {
  readonly sha: string;
  readonly subject: string;
  readonly author_date: string;
  /** `Issue-Event` values paired with this issue's `Issue` trailer. */
  readonly events: readonly string[];
}

/** `issues show <issue> --json`. */
export interface IssueShowJson {
  readonly format: "issues-show/v1";
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  readonly header: StateHeader;
  readonly issue: IssueView;
  readonly body: string | null;
  readonly references: readonly IssueReference[];
  /** On by default; `null` with `--no-comments`. */
  readonly comments: readonly IssueCommentJson[] | null;
  /** Every valid event in fold order with `--history`, else `null`. */
  readonly events: readonly EventEnvelope[] | null;
  /** With `--commits`, else `null`. */
  readonly commits: readonly IssueCommitJson[] | null;
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

/** `issues ready --json`. */
export interface IssueReadyJson {
  readonly format: "issues-ready/v1";
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  readonly filter: {
    readonly labels: readonly string[];
    /** The address `--mine` matched, or `null`. */
    readonly mine: string | null;
    readonly limit: number | null;
  };
  /** In ready order. */
  readonly issues: readonly IssueView[];
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

/** The `numbering` key of the read documents. */
export const numberingJson = (read: IssuesRead): NumberingJson => ({
  available: read.numbering.available,
  reason: read.numbering.reason,
  ref: read.numbering.ref,
});

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Numbered issues by number, then unnumbered ones by `opened_at`, then id. */
export function compareIssues(a: IssueView, b: IssueView): number {
  if (a.number !== null || b.number !== null) {
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    if (a.number !== b.number) return a.number - b.number;
  }
  return cmp(a.opened_at, b.opened_at) || cmp(a.id, b.id);
}

const STATE_ORDER: readonly IssueStatus[] = ["in-progress", "open", "closed"];

/**
 * Whether a stored assignee is `who`: both email addresses (with `@`) that are equal ignoring
 * case, as ADR-0013 compares `on_behalf_of`; otherwise only when exactly equal.
 */
export function matchesAssignee(assignee: string, who: string): boolean {
  if (assignee.includes("@") && who.includes("@")) {
    return assignee.toLowerCase() === who.toLowerCase();
  }
  return assignee === who;
}

/**
 * The address `me` stands for in `--mine`, `--assignee me` and `assign … me`: an agent's
 * `on_behalf_of`, else the human's email. `UsageError` (exit 2) without one.
 */
export function myAddress(actor: Actor, flag = "--mine"): string {
  const address = actor.kind === "agent" ? actor.on_behalf_of : actor.email;
  if (address === null || address === undefined || address === "") {
    throw new UsageError(`${flag} needs your email; set git config user.email`);
  }
  return address;
}

/** Findings of the listed issues and of the log as a whole. */
const findingsOf = (read: IssuesRead, ids: ReadonlySet<string>) =>
  read.findings.filter((f) => f.subject === null || ids.has(f.subject));

/**
 * The `issues-list/v1` document: open and in-progress issues by default, `states` instead when
 * given, every issue with `all`; `assignees` and `labels` AND-ed. Ordered in progress, open,
 * closed, then by number, `opened_at` and id, and truncated to `limit` after ordering.
 */
export function listIssues(
  read: IssuesRead,
  o: {
    readonly states?: readonly IssueStatus[];
    readonly all?: boolean;
    readonly assignees?: readonly string[];
    readonly labels?: readonly string[];
    readonly limit?: number | null;
  } = {},
): IssueListJson {
  const given = o.states ?? [];
  if (o.all === true && given.length > 0)
    throw new UsageError("--all can't be combined with --state");
  const states =
    o.all === true
      ? STATE_ORDER
      : given.length > 0
        ? STATE_ORDER.filter((s) => given.includes(s))
        : (["in-progress", "open"] as const);
  const assignees = o.assignees ?? [];
  const labels = o.labels ?? [];
  const issues = [...read.projection.views.values()]
    .filter((v) => states.includes(v.state))
    .filter((v) => assignees.every((who) => v.assignees.some((a) => matchesAssignee(a, who))))
    .filter((v) => labels.every((l) => v.labels.includes(l)))
    .sort(
      (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || compareIssues(a, b),
    )
    .slice(0, o.limit ?? Number.POSITIVE_INFINITY);
  return {
    format: "issues-list/v1",
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    source: null,
    filter: {
      states: [...states],
      assignees: [...assignees],
      labels: [...labels],
      limit: o.limit ?? null,
    },
    issues,
    unreadable: read.projection.unreadable,
    unfoldable: read.projection.unfoldable,
    findings: findingsOf(read, new Set(issues.map((v) => v.id))),
    notes: readNotes(read),
  };
}

/** The display, title and state of one stored target. */
function reference(read: IssuesRead, rel: IssueReference["rel"], to: string): IssueReference {
  const at = to.indexOf(":");
  if (at < 0) {
    const v = read.projection.views.get(to);
    return {
      rel,
      to,
      display: v?.display ?? to,
      title: v?.title ?? null,
      status: v?.state ?? null,
      checked: true,
    };
  }
  if (to.slice(0, at) === "adr" && read.decisions !== null) {
    const d = read.decisions.views.get(to.slice(at + 1));
    return {
      rel,
      to,
      display: d?.display ?? to,
      title: d?.title ?? null,
      status: d?.status ?? null,
      checked: true,
    };
  }
  return { rel, to, display: to, title: null, status: null, checked: false };
}

/** Every relation of `view`: its current links in fold order, then the derived inverses. */
function referencesOf(read: IssuesRead, view: IssueView): IssueReference[] {
  const links = read.folded.subjects.get(view.id)?.state?.links ?? [];
  let parent = false;
  const out = links.map((l) => {
    if (l.rel === "part-of" && !parent) {
      parent = true;
      return reference(read, "parent", l.to);
    }
    return reference(read, l.rel, l.to);
  });
  if (view.duplicate_of !== null) out.push(reference(read, "duplicate-of", view.duplicate_of));
  for (const id of view.children) out.push(reference(read, "child", id));
  for (const id of view.blocks) out.push(reference(read, "blocks", id));
  for (const id of view.duplicates) out.push(reference(read, "duplicate", id));
  return out;
}

/** The view of `id`, else `UsageError` naming why it can't be shown. */
function viewOf(read: IssuesRead, id: string): IssueView {
  const view = read.projection.views.get(id);
  if (view !== undefined) return view;
  if (read.projection.unreadable.includes(id)) {
    throw new UsageError(`issue ${id} uses a newer format; upgrade issues`);
  }
  if (read.projection.unfoldable.includes(id)) {
    throw new UsageError(`${id} has no valid opened event; run issues verify`);
  }
  throw new UsageError(`unknown issue ${id}`);
}

const decoder = new TextDecoder();

/**
 * The `issues-show/v1` document of the issue `id` (resolve it with `resolveIssue` first): the
 * state header, the body, every reference, the comments (unless `comments` is false), every
 * event with `history`, and the given `commits`.
 */
export function showIssue(
  read: IssuesRead,
  id: string,
  o: {
    readonly history?: boolean;
    readonly comments?: boolean;
    readonly commits?: readonly IssueCommitJson[] | null;
  } = {},
): IssueShowJson {
  const view = viewOf(read, id);
  const subject = read.folded.subjects.get(id);
  const body = subject?.loaded.body ?? null;
  const comments =
    o.comments === false
      ? null
      : (subject?.applied ?? []).flatMap(({ event: e }) =>
          e.type === "commented" ? [{ id: e.id, at: e.at, actor: e.actor, text: e.data.text }] : [],
        );
  const events =
    o.history === true
      ? (subject?.loaded.events ?? [])
          .flatMap((e) => (e.event === null ? [] : [{ path: e.path, event: e.event }]))
          .sort((a, b) => compareEvents({ ...a.event, path: a.path }, { ...b.event, path: b.path }))
          .map((e) => e.event)
      : null;
  return {
    format: "issues-show/v1",
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    header: stateHeader(view, read),
    issue: view,
    body: body === null ? null : decoder.decode(body.bytes),
    references: referencesOf(read, view),
    comments,
    events,
    commits: o.commits ?? null,
    findings: read.findings.filter((f) => f.subject === id),
    notes: readNotes(read),
  };
}

/**
 * The `issues-ready/v1` document: ready issues (open, not blocked, unassigned, no open child)
 * with every label in `labels`. With `mine`, also the issues that would be ready but for being
 * assigned to `mine`, first. Ordered by `[labels] priority` rank, then number, `opened_at` and id.
 */
export function readyIssues(
  read: IssuesRead,
  o: {
    readonly labels?: readonly string[];
    readonly mine?: string | null;
    readonly limit?: number | null;
  } = {},
): IssueReadyJson {
  const labels = o.labels ?? [];
  const mine = o.mine ?? null;
  const priority = read.issues.priority;
  const rank = (v: IssueView) => {
    const ranks = v.labels.map((l) => priority.indexOf(l)).filter((i) => i >= 0);
    return ranks.length === 0 ? priority.length : Math.min(...ranks);
  };
  const order = (a: IssueView, b: IssueView) => rank(a) - rank(b) || compareIssues(a, b);
  const views = [...read.projection.views.values()].filter((v) =>
    labels.every((l) => v.labels.includes(l)),
  );
  const openChild = (v: IssueView) =>
    v.children.some((c) => read.projection.views.get(c)?.state !== "closed");
  const assignedToMe =
    mine === null
      ? []
      : views.filter(
          (v) =>
            v.state === "open" &&
            !v.blocked &&
            !openChild(v) &&
            v.assignees.some((a) => matchesAssignee(a, mine)),
        );
  const issues = [...assignedToMe.sort(order), ...views.filter((v) => v.ready).sort(order)].slice(
    0,
    o.limit ?? Number.POSITIVE_INFINITY,
  );
  return {
    format: "issues-ready/v1",
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    filter: { labels: [...labels], mine, limit: o.limit ?? null },
    issues,
    findings: findingsOf(read, new Set(issues.map((v) => v.id))),
    notes: readNotes(read),
  };
}

const day = (at: string | null) => (at ?? "").slice(0, 10);
const RESOLUTION_WORDS: Readonly<Record<string, string>> = {
  done: "done",
  wontfix: "won't fix",
  duplicate: "a duplicate",
  obsolete: "obsolete",
};

/** The reason on the issue's current `closed` event, if any. */
function closeReason(read: IssuesRead, id: string): string | null {
  const applied = read.folded.subjects.get(id)?.applied ?? [];
  const reason = applied.findLast((a) => a.event.type === "closed")?.event.reason;
  return typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
}

/**
 * The state header: `<display> (<id>) · <state>`, and a warning for an issue that isn't the place
 * to work: a duplicate (where to track the work), a closed issue, or a blocked one. `refer` names
 * where to read another issue; the CLI's default is its display.
 */
export function stateHeader(
  view: IssueView,
  read: IssuesRead,
  o: { readonly refer?: (id: string) => string } = {},
): StateHeader {
  const display = (id: string) => read.projection.views.get(id)?.display ?? id;
  const refer = o.refer ?? display;
  const line =
    view.number === null
      ? `${view.id} · ${view.state}`
      : `${view.display} (${view.id}) · ${view.state}`;
  let warning: string | null = null;
  if (view.state === "closed" && view.resolution === "duplicate") {
    const target = view.canonical ?? view.duplicate_of ?? view.id;
    const state = read.projection.views.get(target)?.state ?? "unknown";
    warning = `DUPLICATE of ${display(target)} (${state}). Track work on ${display(target)}; read ${refer(target)}.`;
  } else if (view.state === "closed") {
    const reason = closeReason(read, view.id);
    const as = RESOLUTION_WORDS[view.resolution ?? "done"] ?? view.resolution;
    warning = `CLOSED on ${day(view.closed_at)} as ${as}${reason === null ? "" : `: ${reason}`}.`;
  } else if (view.blocked) {
    const by = view.blocked_by_open.map(
      (id) => `${display(id)} (${read.projection.views.get(id)?.state ?? "unknown"})`,
    );
    warning = `BLOCKED by ${by.join(", ")}. Finish them first.`;
  }
  return { line, warning };
}
