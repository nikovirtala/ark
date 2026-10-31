import { posix } from "node:path";
import {
  type Check,
  escapeMarkdown,
  type Git,
  type IndexSpec,
  indexAfterHint,
  indexBeforeHint,
  indexRerunHint,
  type IndexRun as LedgerIndexRun,
  type LogIndexJson,
  type LogLayout,
  logIndexCheck,
  renderIndex,
  renderLogIndex,
  runLogIndex,
  type ToolWriteOptions,
  type TreeReader,
} from "@nikovirtala/ledger";
import { INDEX_ACTION, INDEX_TITLE } from "./commit-actions.js";
import type { IssuesConfig } from "./config.js";
import { type IssueView, issueKind } from "./kind.js";
import { type IssueLog, type IssuesRead, readIssuesFrom } from "./log.js";
import type { WriteOptions } from "./write.js";

/** `issues index --json`: adr-index/v1's shape. */
export type IssueIndexJson = LogIndexJson<"issues-index/v1">;

/** What the recovery hint says about rerunning `issues index --commit` after `git commit` failed. */
export const INDEX_RERUN = indexRerunHint("issues");

/** The step before the manual commit when a write's second index render failed after staging. */
export const INDEX_BEFORE = (root: string): string => indexBeforeHint("issues", "issues", root);

/** The step after the manual commit when the commit carried the index. */
export const INDEX_AFTER = (root: string): string => indexAfterHint("issues", "issues", root);

/** How many closed issues the index lists. */
const RECENTLY_CLOSED = 20;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const list = (xs: readonly string[]) => xs.map(escapeMarkdown).join(", ");

/**
 * Closed issues by `closed_at`, newest first, then id: the rule that picks the recently closed
 * issues and the order they're listed in, so the last row is the next one to drop off.
 */
const byLatestClose = (a: IssueView, b: IssueView) =>
  cmp(b.closed_at ?? "", a.closed_at ?? "") || cmp(a.id, b.id);

/**
 * issues' index spec (02 "Generated index"): in progress, ready, blocked, the other open issues
 * (assigned, or with open children), and the 20 most recently closed, first match wins.
 * "Recently closed" is ordered by `byLatestClose`. The other sections hold no closed issue and are
 * ordered by `state_at` (the last opened, started, stopped or reopened event, the date in "Since"),
 * oldest first, then number, `opened_at` and id.
 */
export const ISSUE_INDEX = (
  root: string,
  recentlyClosed: ReadonlySet<string>,
): IndexSpec<IssueView> => ({
  tool: "issues",
  title: "Issues",
  groups: [
    { heading: "In progress", filter: (v: IssueView) => v.state === "in-progress" },
    { heading: "Ready", filter: (v: IssueView) => v.ready },
    { heading: "Blocked", filter: (v: IssueView) => v.state === "open" && v.blocked },
    { heading: "Open", filter: (v: IssueView) => v.state === "open" },
    { heading: "Recently closed", filter: (v: IssueView) => recentlyClosed.has(v.id) },
  ],
  columns: [
    { heading: "Issue", cell: (v) => escapeMarkdown(v.display) },
    {
      heading: "Title",
      cell: (v) =>
        v.body_path === null
          ? escapeMarkdown(v.title)
          : `[${escapeMarkdown(v.title)}](${encodeURI(posix.relative(root, v.body_path))})`,
    },
    { heading: "Assignees", cell: (v) => list(v.assignees) },
    { heading: "Labels", cell: (v) => list(v.labels) },
    { heading: "Since", cell: (v) => v.state_at.slice(0, 10) },
  ],
  order: (a, b) =>
    a.state === "closed" && b.state === "closed"
      ? byLatestClose(a, b)
      : cmp(a.state_at, b.state_at) ||
        (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY) ||
        cmp(a.opened_at, b.opened_at) ||
        cmp(a.id, b.id),
});

/** The ids of the `RECENTLY_CLOSED` closed issues first in `byLatestClose` order. */
function recentlyClosedOf(views: Iterable<IssueView>): Set<string> {
  const closed = [...views].filter((v) => v.state === "closed").sort(byLatestClose);
  return new Set(closed.slice(0, RECENTLY_CLOSED).map((v) => v.id));
}

/** `ISSUE_INDEX` for `views`, with its recently closed issues picked from them. */
const issueSpec = (root: string, views: readonly IssueView[]): IndexSpec<IssueView> =>
  ISSUE_INDEX(root, recentlyClosedOf(views));

/**
 * The index `tree` must hold: its issues, numbered as they will be once the commit holding `tree`
 * (which builds on `history`: HEAD, a commit, or null on an unborn HEAD) is on main, with
 * `[log] main_branch`'s numbers first; ledger's `renderLogIndex`. It reads no sources and no
 * decision log, so it depends only on the tree: an issue blocked only by an open issue in another
 * repository shows as Ready. `null` when the numbers can't be projected (a shallow clone whose
 * `history` recorded none).
 */
export async function renderIssueIndex(
  git: Git,
  o: {
    readonly layout: LogLayout;
    readonly issues: IssuesConfig;
    readonly tree: TreeReader;
    readonly history: string | null;
  },
): Promise<string | null> {
  const { layout, issues } = o;
  return renderLogIndex(git, {
    kind: issueKind,
    layout,
    mainRef: issues.mainBranch,
    tree: o.tree,
    history: o.history,
    async views(tree, numbering) {
      const read = await readIssuesFrom(tree, { layout, issues, numbering, sources: null });
      return [...read.projection.views.values()];
    },
    spec: issueSpec,
  });
}

/**
 * The index table of `read`, as `index.md` holds it, numbered like every other read (the
 * `issues://index` resource). Works with `[log] index = "none"` too.
 */
export function renderIssueIndexText(read: IssuesRead): string {
  const views = [...read.projection.views.values()];
  return renderIndex(issueSpec(read.root, views), views, read.numbering);
}

const indexWords = (log: IssueLog) =>
  ({
    tool: "issues",
    noun: "issue",
    render: (git: Git, at: { readonly tree: TreeReader; readonly history: string | null }) =>
      renderIssueIndex(git, { layout: log.layout, issues: log.issues, ...at }),
  }) as const;

/**
 * The verify check that `<root>/index.md` is current, ledger's `logIndexCheck`: in staged mode, a
 * stale staged copy that equals the work tree's render names the unstaged issue files instead.
 */
export function issueIndexCheck(log: IssueLog): Check {
  return logIndexCheck(log, indexWords(log));
}

/** `issues index`'s result and whether the work-tree refresh after a commit changed a copy. */
export type IndexRun = LedgerIndexRun<"issues-index/v1">;

/** `issues index` with what the text output needs; `indexIssueLog` is the library entry. */
export async function runIssueIndex(
  log: IssueLog,
  o: ToolWriteOptions & { readonly check?: boolean } = {},
): Promise<IndexRun> {
  return runLogIndex(
    log,
    {
      ...indexWords(log),
      plural: "issues",
      format: "issues-index/v1",
      index: log.issues.index,
      autoCommit: log.issues.autoCommit,
      commitSubject: log.issues.commitSubject,
      title: INDEX_TITLE,
      action: INDEX_ACTION,
    },
    o,
  );
}

/**
 * `issues index [--check] [--commit | --no-commit] [-m <message>]`: renders `<root>/index.md` and
 * writes and stages it where the work tree or the index differ. With `commit` (default `[policy]
 * auto_commit`) it renders HEAD's tree and commits the file alone when HEAD's copy differs, then
 * refreshes the work tree's copy. `check` writes nothing and reports `index/*` findings.
 */
export async function indexIssueLog(
  log: IssueLog,
  o: WriteOptions & { readonly check?: boolean } = {},
): Promise<IssueIndexJson> {
  return (await runIssueIndex(log, o)).doc;
}
