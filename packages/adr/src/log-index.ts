import { posix } from "node:path";
import {
  type Check,
  ConfigError,
  classifyPath,
  commitWithRecovery,
  escapeMarkdown,
  type Finding,
  type Git,
  type IndexSpec,
  indexCheck,
  indexReader,
  type LogLayout,
  MemoryTree,
  projectNumbering,
  readIndexNumbers,
  refReader,
  renderCommitMessage,
  renderIndex,
  type TreeReader,
  UsageError,
  verifyLog,
  worktreeReader,
  writeIndexFile,
} from "@nikovirtala/ledger";
import { INDEX_ACTION, INDEX_TITLE } from "./commit-actions.js";
import type { AdrConfig } from "./config.js";
import { adrKind, type DecisionView } from "./kind.js";
import { type DecisionLog, readDecisionsFrom } from "./log.js";
import type { WriteOptions } from "./write.js";

/** `adr index --json` (design 2b §4.5). */
export interface IndexResultJson {
  readonly format: "adr-index/v1";
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

/**
 * What the recovery hint says about rerunning `adr index --commit` after `git commit` failed
 * (design 2b D5). It names the file, not the path, which the hint lists above it.
 */
export const INDEX_RERUN =
  "You can also run adr index --commit again once git accepts the commit; it commits index.md while it differs from HEAD's.";

/**
 * The step before the manual commit when a write's second index render failed after staging
 * (design 2b §4.5 step 4).
 */
export const INDEX_BEFORE = (root: string): string =>
  `Run adr index --no-commit first; it writes and stages ${root}/index.md from the work tree. If other decisions in ${root} have uncommitted changes, the work tree's index includes them; append their paths after -- in the command below, so the commit matches the index.`;

/**
 * The step after the manual commit when the commit carried the index: the commit's render leaves
 * out other decisions' uncommitted entries (design 2b D5, §4.5 step 5).
 */
export const INDEX_AFTER = (root: string): string =>
  `Then run adr index --no-commit to restore other decisions' entries in ${root}/index.md.`;

/** The repo-relative path of a log's generated index. */
export const indexPath = (layout: LogLayout): string => `${layout.root}/index.md`;

const GROUPS: readonly { readonly heading: string; readonly statuses: readonly string[] }[] = [
  { heading: "Accepted", statuses: ["accepted"] },
  { heading: "Proposed", statuses: ["proposed"] },
  { heading: "Superseded and deprecated", statuses: ["superseded", "deprecated"] },
  { heading: "Rejected and withdrawn", statuses: ["rejected", "withdrawn"] },
];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * adr's index spec (01:209: active decisions first), built per render so that a superseded
 * decision's status can name its successor's display from `views`.
 */
export const DECISION_INDEX = (
  root: string,
  views: ReadonlyMap<string, DecisionView>,
): IndexSpec<DecisionView> => ({
  tool: "adr",
  title: "Architecture decisions",
  groups: GROUPS.map((g) => ({
    heading: g.heading,
    filter: (v: DecisionView) => g.statuses.includes(v.status),
  })),
  columns: [
    { heading: "Decision", cell: (v) => escapeMarkdown(v.display) },
    {
      heading: "Title",
      cell: (v) =>
        v.body_path === null
          ? escapeMarkdown(v.title)
          : `[${escapeMarkdown(v.title)}](${encodeURI(posix.relative(root, v.body_path))})`,
    },
    {
      heading: "Status",
      cell: (v) =>
        v.status === "superseded" && v.superseded_by !== null
          ? `superseded by ${escapeMarkdown(views.get(v.superseded_by)?.display ?? v.superseded_by)}`
          : v.status,
    },
    { heading: "Since", cell: (v) => v.status_at.slice(0, 10) },
  ],
  order: (a, b) =>
    (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY) ||
    cmp(a.status_at, b.status_at) ||
    cmp(a.id, b.id),
});

/**
 * The index `tree` must hold: its decisions, numbered as they will be once the commit holding
 * `tree` (which builds on `history`: HEAD, a commit, or null on an unborn HEAD) is on main
 * (design 2b D2), with `[log] main_branch`'s numbers first. A tree that isn't a commit's (the work
 * tree, the index) also merges `MERGE_HEAD` while a merge is in progress. In a shallow clone the
 * numbers continue from those `history`'s index recorded; `null` when there are none, so the
 * numbers can't be projected.
 */
export async function renderDecisionIndex(
  git: Git,
  o: {
    readonly layout: LogLayout;
    readonly adr: AdrConfig;
    readonly tree: TreeReader;
    readonly history: string | null;
  },
): Promise<string | null> {
  const { layout, history } = o;
  const mergeHead =
    o.tree.commit === null && history !== null ? await git.resolveCommit("MERGE_HEAD") : null;
  const numbering = await projectNumbering(git, {
    kind: adrKind,
    layout,
    history,
    tree: o.tree,
    mainRef: o.adr.mainBranch,
    merging: mergeHead === null ? [] : [mergeHead],
    recorded: async () =>
      history === null ? null : readIndexNumbers(await refReader(git, history), indexPath(layout)),
  });
  if (!numbering.available) return null;
  const read = await readDecisionsFrom(o.tree, { layout, adr: o.adr, numbering });
  const views = read.projection.views;
  return renderIndex(DECISION_INDEX(layout.root, views), [...views.values()], numbering);
}

/** At most this many paths are named in the unstaged-files `index/stale` message. */
const UNSTAGED_NAMED = 5;

/**
 * What the unstaged-files `index/stale` finding and the matching write note both start with:
 * `path` lists `files` (some of them), which aren't staged.
 */
export function unstagedIndexText(path: string, files: readonly string[]): string {
  const named = files.slice(0, UNSTAGED_NAMED).join(", ");
  const more = files.length > UNSTAGED_NAMED ? ", …" : "";
  return `${path} lists decision files that aren't staged (${named}${more})`;
}

/**
 * The log's event and body files whose work-tree content isn't staged (untracked or modified),
 * sorted: the cause of a staged `index.md` that only the work tree's render matches.
 */
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
 * The verify check that `<root>/index.md` is current (design 2b §4.5, "Freshness in verify"). In
 * staged mode (the pre-commit hook), a stale staged copy that equals the work tree's render
 * means another decision's files aren't staged: writes stage the work tree's render (D2), and
 * `adr index` would change nothing. The finding then names those files and says to stage them.
 */
export function decisionIndexCheck(log: DecisionLog): Check {
  const path = indexPath(log.layout);
  const check = indexCheck({
    path,
    fix: "run adr index",
    async expected(ctx) {
      const head = ctx.repo?.head;
      const history =
        head === undefined
          ? null
          : typeof head === "object"
            ? head.commit
            : await log.git.resolveCommit("HEAD");
      return renderDecisionIndex(log.git, {
        layout: log.layout,
        adr: log.adr,
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
      const worktree = await renderDecisionIndex(log.git, {
        layout: log.layout,
        adr: log.adr,
        tree: worktreeReader(log.git),
        history: await log.git.resolveCommit("HEAD"),
      });
      if (worktree === null || !holdsText(await ctx.head.tree.read(path), worktree)) {
        return findings;
      }
      const message = `${unstagedIndexText(path, files)}; git add them and commit again, or move them out of the work tree and run adr index`;
      return findings.map((f) => (f === stale ? { ...f, message } : f));
    },
  };
}

const encoder = new TextEncoder();

/** Whether `bytes` (null: absent) hold exactly `text`. */
export function holdsText(bytes: Uint8Array | null, text: string): boolean {
  if (bytes === null) return false;
  const want = encoder.encode(text);
  return bytes.byteLength === want.byteLength && bytes.every((x, i) => x === want[i]);
}

/** HEAD's copy of `path`; `null` when it is absent or HEAD is unborn. */
export async function headBytes(git: Git, path: string): Promise<Uint8Array | null> {
  const head = await git.resolveCommit("HEAD");
  return head === null ? null : (await refReader(git, head)).read(path);
}

/** HEAD's tree, or an empty tree on an unborn HEAD. */
export async function headTree(git: Git, head: string | null): Promise<TreeReader> {
  return head === null ? new MemoryTree({}) : refReader(git, head);
}

/**
 * Brings the work-tree copy of `path` to `text` (atomically, when it differs) and reports whether
 * the staged copy differs, so the caller stages it. `old` is the work-tree copy before the write
 * (`null` when absent), for rollback.
 */
export async function writeIndexCopy(
  git: Git,
  path: string,
  text: string,
): Promise<{ readonly wrote: boolean; readonly old: Uint8Array | null; readonly stage: boolean }> {
  const old = await worktreeReader(git).read(path);
  const wrote = !holdsText(old, text) && (await writeIndexFile(git, path, text));
  const stage = !holdsText(await (await indexReader(git)).read(path), text);
  return { wrote, old, stage };
}

/** The first line of an error's message, for notes and headlines. */
export const firstLine = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";

/** `adr index`'s result and whether the work-tree refresh after a commit changed a copy. */
export interface IndexRun {
  readonly doc: IndexResultJson;
  /** With a commit requested: step 5 wrote or staged the work tree's render. */
  readonly refreshed: boolean;
}

/**
 * `adr index` (design 2b §4.5) with what the text output needs; `indexDecisionLog` is the
 * library entry.
 */
export async function runDecisionIndex(
  log: DecisionLog,
  o: WriteOptions & { readonly check?: boolean } = {},
): Promise<IndexRun> {
  const path = indexPath(log.layout);
  const root = log.layout.root;
  const check = o.check === true;
  const notes = [...log.notes, ...(o.notes ?? [])];
  if (log.adr.index !== "committed") {
    throw new UsageError('adr index needs [log] index = "committed" in adr.toml');
  }
  if (check) {
    if (o.commit === true || (o.message !== undefined && o.message !== null)) {
      throw new UsageError("--check writes nothing; drop --commit and --message");
    }
    const findings = await verifyLog({
      git: log.git,
      kind: adrKind,
      layout: log.layout,
      mode: { type: "full", ...(log.ref === null ? {} : { head: log.ref }) },
      checks: [decisionIndexCheck(log)],
    });
    const doc: IndexResultJson = {
      format: "adr-index/v1",
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
    throw new UsageError("adr index writes the work tree; use --ref only with --check");
  }
  const { git } = log;
  const commit = o.commit ?? log.adr.autoCommit;
  if (commit && ((await git.identity()) === null || (await git.committerIdentity()) === null)) {
    throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
  }
  const head = await git.resolveCommit("HEAD");
  const render = (tree: TreeReader, history: string | null) =>
    renderDecisionIndex(git, { layout: log.layout, adr: log.adr, tree, history });
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
    const doc: IndexResultJson = {
      format: "adr-index/v1",
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
      renderCommitMessage(log.adr.commitSubject, {
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
  // Step 5: other decisions' uncommitted entries go back into the work tree and the index.
  let refreshed = false;
  try {
    const again = await render(worktreeReader(git), sha ?? head);
    if (again !== null) refreshed = await place(again);
  } catch (err) {
    notes.push(`${path} may be stale: ${firstLine(err)}; run adr index`);
  }
  const doc: IndexResultJson = {
    format: "adr-index/v1",
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
 * `adr index [--check] [--commit | --no-commit] [-m <message>]` (design 2b §4.5): renders
 * `<root>/index.md` and writes and stages it where the work tree or the index differ. With
 * `commit` (default `[policy] auto_commit`) it renders HEAD's tree and commits the file alone when
 * HEAD's copy differs, then refreshes the work tree's copy, which may include other decisions'
 * uncommitted entries. `check` writes nothing and reports `index/*` findings.
 */
export async function indexDecisionLog(
  log: DecisionLog,
  o: WriteOptions & { readonly check?: boolean } = {},
): Promise<IndexResultJson> {
  return (await runDecisionIndex(log, o)).doc;
}
