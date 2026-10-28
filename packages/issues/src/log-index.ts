import { posix } from "node:path";
import {
  type Check,
  ConfigError,
  classifyPath,
  commitWithRecovery,
  escapeMarkdown,
  type Finding,
  firstLine,
  type Git,
  headBytes,
  headTree,
  holdsText,
  type IndexSpec,
  indexCheck,
  type LogLayout,
  projectNumbering,
  readIndexNumbers,
  refReader,
  renderCommitMessage,
  renderIndex,
  type TreeReader,
  UsageError,
  verifyLog,
  worktreeReader,
  writeIndexCopy,
} from "@nikovirtala/ledger";
import { INDEX_ACTION, INDEX_TITLE } from "./commit-actions.js";
import type { IssuesConfig } from "./config.js";
import { type IssueView, issueKind } from "./kind.js";
import { type IssueLog, type IssuesRead, readIssuesFrom } from "./log.js";
import type { WriteOptions } from "./write.js";

/** `issues index --json`: adr-index/v1's shape. */
export interface IssueIndexJson {
  readonly format: "issues-index/v1";
  /** The index file, repo-relative: `<root>/index.md`. */
  readonly path: string;
  readonly check: boolean;
  /**
   * `--check`: no finding. Otherwise: the copies the command compares (the work tree and the
   * index, or HEAD's when committing) already held the render.
   */
  readonly fresh: boolean;
  /** Repo-relative paths this command wrote. */
  readonly written: readonly string[];
  readonly commit: string | null;
  /** `--check`'s findings; `[]` otherwise. */
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

/** What the recovery hint says about rerunning `issues index --commit` after `git commit` failed. */
export const INDEX_RERUN =
  "You can also run issues index --commit again once git accepts the commit; it commits index.md while it differs from HEAD's.";

/** The step before the manual commit when a write's second index render failed after staging. */
export const INDEX_BEFORE = (root: string): string =>
  `Run issues index --no-commit first; it writes and stages ${root}/index.md from the work tree. If other issues in ${root} have uncommitted changes, the work tree's index includes them; append their paths after -- in the command below, so the commit matches the index.`;

/** The step after the manual commit when the commit carried the index. */
export const INDEX_AFTER = (root: string): string =>
  `Then run issues index --no-commit to restore other issues' entries in ${root}/index.md.`;

/** The repo-relative path of a log's generated index. */
export const indexPath = (layout: LogLayout): string => `${layout.root}/index.md`;

/** How many closed issues the index lists. */
const RECENTLY_CLOSED = 20;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const list = (xs: readonly string[]) => xs.map(escapeMarkdown).join(", ");

/**
 * issues' index spec (02 "Generated index"): in progress, ready, blocked, the other open issues
 * (assigned, or with open children), and the 20 most recently closed, first match wins.
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
    (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY) ||
    cmp(a.opened_at, b.opened_at) ||
    cmp(a.id, b.id),
});

/** The ids of the `RECENTLY_CLOSED` closed issues with the latest `closed_at`, then id. */
function recentlyClosedOf(views: Iterable<IssueView>): Set<string> {
  const closed = [...views]
    .filter((v) => v.state === "closed")
    .sort((a, b) => cmp(b.closed_at ?? "", a.closed_at ?? "") || cmp(a.id, b.id));
  return new Set(closed.slice(0, RECENTLY_CLOSED).map((v) => v.id));
}

/**
 * The index `tree` must hold: its issues, numbered as they will be once the commit holding `tree`
 * (which builds on `history`: HEAD, a commit, or null on an unborn HEAD) is on main, with
 * `[log] main_branch`'s numbers first; adr's `renderDecisionIndex` rule. It reads no sources and
 * no decision log, so it depends only on the tree: an issue blocked only by an open issue in
 * another repository shows as Ready. `null` when the numbers can't be projected (a shallow clone
 * whose `history` recorded none).
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
  const { layout, history } = o;
  const mergeHead =
    o.tree.commit === null && history !== null ? await git.resolveCommit("MERGE_HEAD") : null;
  const numbering = await projectNumbering(git, {
    kind: issueKind,
    layout,
    history,
    tree: o.tree,
    mainRef: o.issues.mainBranch,
    merging: mergeHead === null ? [] : [mergeHead],
    recorded: async () =>
      history === null ? null : readIndexNumbers(await refReader(git, history), indexPath(layout)),
  });
  if (!numbering.available) return null;
  const read = await readIssuesFrom(o.tree, {
    layout,
    issues: o.issues,
    numbering,
    sources: null,
  });
  const views = [...read.projection.views.values()];
  return renderIndex(ISSUE_INDEX(layout.root, recentlyClosedOf(views)), views, numbering);
}

/**
 * The index table of `read`, as `index.md` holds it, numbered like every other read (the
 * `issues://index` resource). Works with `[log] index = "none"` too.
 */
export function renderIssueIndexText(read: IssuesRead): string {
  const views = [...read.projection.views.values()];
  return renderIndex(ISSUE_INDEX(read.root, recentlyClosedOf(views)), views, read.numbering);
}

/** At most this many paths are named in the unstaged-files `index/stale` message. */
const UNSTAGED_NAMED = 5;

/** What the unstaged-files `index/stale` finding and the matching write note both start with. */
export function unstagedIndexText(path: string, files: readonly string[]): string {
  const named = files.slice(0, UNSTAGED_NAMED).join(", ");
  const more = files.length > UNSTAGED_NAMED ? ", …" : "";
  return `${path} lists issue files that aren't staged (${named}${more})`;
}

/** The log's event and body files whose work-tree content isn't staged, sorted. */
export async function unstagedLogFiles(git: Git, layout: LogLayout): Promise<string[]> {
  const paths = [
    ...(await git.unstagedPaths([layout.root])),
    ...(await git.untrackedPaths([layout.root])),
  ];
  return [...new Set(paths)]
    .filter((p) => {
      const area = classifyPath(layout, p).area;
      return area === "event" || area === "body";
    })
    .sort();
}

/**
 * The verify check that `<root>/index.md` is current, adr's `decisionIndexCheck`: in staged mode,
 * a stale staged copy that equals the work tree's render names the unstaged issue files instead.
 */
export function issueIndexCheck(log: IssueLog): Check {
  const path = indexPath(log.layout);
  const check = indexCheck({
    path,
    fix: "run issues index",
    async expected(ctx) {
      const head = ctx.repo?.head;
      const history =
        head === undefined
          ? null
          : typeof head === "object"
            ? head.commit
            : await log.git.resolveCommit("HEAD");
      return renderIssueIndex(log.git, {
        layout: log.layout,
        issues: log.issues,
        tree: ctx.head.tree,
        history,
      });
    },
  });
  return {
    id: check.id,
    async run(ctx) {
      const findings = await check.run(ctx);
      const stale = findings.find((f) => f.rule === "index/stale");
      if (stale === undefined || ctx.repo?.head !== "index") return findings;
      const files = await unstagedLogFiles(log.git, log.layout);
      if (files.length === 0) return findings;
      const worktree = await renderIssueIndex(log.git, {
        layout: log.layout,
        issues: log.issues,
        tree: worktreeReader(log.git),
        history: await log.git.resolveCommit("HEAD"),
      });
      if (worktree === null || !holdsText(await ctx.head.tree.read(path), worktree)) {
        return findings;
      }
      const message = `${unstagedIndexText(path, files)}; git add them and commit again, or move them out of the work tree and run issues index`;
      return findings.map((f) => (f === stale ? { ...f, message } : f));
    },
  };
}

/** `issues index`'s result and whether the work-tree refresh after a commit changed a copy. */
export interface IndexRun {
  readonly doc: IssueIndexJson;
  /** With a commit requested: the refresh after it wrote or staged the work tree's render. */
  readonly refreshed: boolean;
}

/** `issues index` with what the text output needs; `indexIssueLog` is the library entry. */
export async function runIssueIndex(
  log: IssueLog,
  o: WriteOptions & { readonly check?: boolean } = {},
): Promise<IndexRun> {
  const path = indexPath(log.layout);
  const root = log.layout.root;
  const check = o.check === true;
  const notes = [...log.notes, ...(o.notes ?? [])];
  if (log.issues.index !== "committed") {
    throw new UsageError('issues index needs [log] index = "committed" in issues.toml');
  }
  if (check) {
    if (o.commit === true || (o.message !== undefined && o.message !== null)) {
      throw new UsageError("--check writes nothing; drop --commit and --message");
    }
    const findings = await verifyLog({
      git: log.git,
      kind: issueKind,
      layout: log.layout,
      mode: { type: "full", ...(log.ref === null ? {} : { head: log.ref }) },
      checks: [issueIndexCheck(log)],
    });
    const doc: IssueIndexJson = {
      format: "issues-index/v1",
      path,
      check: true,
      fresh: findings.length === 0,
      written: [],
      commit: null,
      findings,
      notes,
    };
    return { doc, refreshed: false };
  }
  if (log.ref !== null || log.tree.label !== "worktree") {
    throw new UsageError("issues index writes the work tree; use --ref only with --check");
  }
  const { git } = log;
  const commit = o.commit ?? log.issues.autoCommit;
  if (commit && ((await git.identity()) === null || (await git.committerIdentity()) === null)) {
    throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
  }
  const head = await git.resolveCommit("HEAD");
  const render = (tree: TreeReader, history: string | null) =>
    renderIssueIndex(git, { layout: log.layout, issues: log.issues, tree, history });
  const shallow = () =>
    new UsageError("numbers need history in this shallow clone; run git fetch --unshallow");
  let written = false;
  const place = async (text: string): Promise<boolean> => {
    const r = await writeIndexCopy(git, path, text);
    if (r.stage) await git.add([path]);
    written ||= r.wrote;
    return r.wrote || r.stage;
  };

  if (!commit) {
    const text = await render(worktreeReader(git), head);
    if (text === null) throw shallow();
    const changed = await place(text);
    const doc: IssueIndexJson = {
      format: "issues-index/v1",
      path,
      check: false,
      fresh: !changed,
      written: written ? [path] : [],
      commit: null,
      findings: [],
      notes,
    };
    return { doc, refreshed: false };
  }

  // The commit's only path is index.md, which the render doesn't read, so it renders HEAD's tree;
  // HEAD's copy decides whether there is anything to commit.
  const text = await render(await headTree(git, head), head);
  if (text === null) throw shallow();
  const fresh = holdsText(await headBytes(git, path), text);
  let sha: string | null = null;
  if (!fresh) {
    await place(text);
    const message =
      o.message ??
      renderCommitMessage(log.issues.commitSubject, {
        title: INDEX_TITLE,
        vars: { action: INDEX_ACTION, id: "index.md", display: "index.md", command: "index" },
      }).message;
    sha = await commitWithRecovery(git, {
      message,
      only: [path],
      rerun: INDEX_RERUN,
      after: INDEX_AFTER(root),
    });
  }
  // Other issues' uncommitted entries go back into the work tree and the index.
  let refreshed = false;
  try {
    const again = await render(worktreeReader(git), sha ?? head);
    if (again !== null) refreshed = await place(again);
  } catch (err) {
    notes.push(`${path} may be stale: ${firstLine(err)}; run issues index`);
  }
  const doc: IssueIndexJson = {
    format: "issues-index/v1",
    path,
    check: false,
    fresh,
    written: written ? [path] : [],
    commit: sha,
    findings: [],
    notes,
  };
  return { doc, refreshed };
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
