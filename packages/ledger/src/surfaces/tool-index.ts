import { ConfigError, UsageError } from "../errors.js";
import type { Finding } from "../findings/finding.js";
import type { Git } from "../git/git.js";
import { withGitOperation } from "../git/operation.js";
import { type TreeReader, worktreeReader } from "../git/tree.js";
import { indexCheck } from "../log-index/check.js";
import { firstLine, headBytes, headTree, holdsText, writeIndexCopy } from "../log-index/copies.js";
import { indexPath, unstagedIndexText, unstagedLogFiles } from "../log-index/tool-render.js";
import type { Check } from "../verify/checks.js";
import { verifyLog } from "../verify/verify.js";
import { type CommitTemplate, renderCommitMessage } from "./commit-message.js";
import { commitWithRecovery } from "./commit-recovery.js";
import type { ToolLog } from "./tool-log.js";

/**
 * What the recovery hint says about rerunning `<tool> index --commit` after `git commit` failed
 * (design 2b D5). It names the file, not the path, which the hint lists above it.
 */
export const indexRerunHint = (tool: string): string =>
  `You can also run ${tool} index --commit again once git accepts the commit; it commits index.md while it differs from HEAD's.`;

/**
 * The step before the manual commit when a write's second index render failed after staging
 * (design 2b §4.5 step 4). `plural` names the log's subjects, such as `"decisions"`.
 */
export const indexBeforeHint = (tool: string, plural: string, root: string): string =>
  `Run ${tool} index --no-commit first; it writes and stages ${root}/index.md from the work tree. If other ${plural} in ${root} have uncommitted changes, the work tree's index includes them; append their paths after -- in the command below, so the commit matches the index.`;

/**
 * The step after the manual commit when the commit carried the index: the commit's render leaves
 * out other subjects' uncommitted entries (design 2b D5, §4.5 step 5).
 */
export const indexAfterHint = (tool: string, plural: string, root: string): string =>
  `Then run ${tool} index --no-commit to restore other ${plural}' entries in ${root}/index.md.`;

/** The options a tool's writes and its `index` command share. */
export interface ToolWriteOptions {
  /** Commit the write; default `[policy] auto_commit`. */
  readonly commit?: boolean;
  /** The commit message to use instead of the `[commit] subject` one; used only when committing. */
  readonly message?: string | null;
  /** Notes to report before the write's own, such as the attribution notes. */
  readonly notes?: readonly string[];
  /**
   * With `[log] index = "committed"`: `"refresh"` (the default) keeps `<root>/index.md` fresh;
   * `"skip"` leaves it alone (the pre-commit hook's rename following, design 2b D8).
   */
  readonly index?: "refresh" | "skip";
}

/**
 * A tool's index render with its spec bound: the index `tree` must hold, given the commit it
 * builds on (`renderLogIndex`), or `null` when the numbers can't be projected.
 */
export type LogIndexRender = (
  git: Git,
  at: { readonly tree: TreeReader; readonly history: string | null },
) => Promise<string | null>;

/** `<tool> index --json`, such as `adr-index/v1` (design 2b §4.5). */
export interface LogIndexJson<F extends string = string> {
  readonly format: F;
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

/** `<tool> index`'s result and whether the work-tree refresh after a commit changed a copy. */
export interface IndexRun<F extends string = string> {
  readonly doc: LogIndexJson<F>;
  /** With a commit requested: step 5 wrote or staged the work tree's render. */
  readonly refreshed: boolean;
}

/** What `logIndexCheck` needs besides the log. */
export interface LogIndexCheckOptions {
  /** The tool's name, for the fixes the findings name (`run <tool> index`). */
  readonly tool: string;
  /** What the log's subjects are called, such as `"decision"`. */
  readonly noun: string;
  readonly render: LogIndexRender;
}

/**
 * The verify check that `<root>/index.md` is current (design 2b §4.5, "Freshness in verify"). In
 * staged mode (the pre-commit hook), a stale staged copy that equals the work tree's render
 * means another subject's files aren't staged: writes stage the work tree's render (D2), and
 * `<tool> index` would change nothing. The finding then names those files and says to stage them.
 */
export function logIndexCheck(log: ToolLog, o: LogIndexCheckOptions): Check {
  const path = indexPath(log.layout);
  const check = indexCheck({
    path,
    fix: `run ${o.tool} index`,
    async expected(ctx) {
      const head = ctx.repo?.head;
      const history =
        head === undefined
          ? null
          : typeof head === "object"
            ? head.commit
            : await log.git.resolveCommit("HEAD");
      return o.render(log.git, { tree: ctx.head.tree, history });
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
      const worktree = await o.render(log.git, {
        tree: worktreeReader(log.git),
        history: await log.git.resolveCommit("HEAD"),
      });
      if (worktree === null || !holdsText(await ctx.head.tree.read(path), worktree)) {
        return findings;
      }
      const message = `${unstagedIndexText(path, files, o.noun)}; git add them and commit again, or move them out of the work tree and run ${o.tool} index`;
      return findings.map((f) => (f === stale ? { ...f, message } : f));
    },
  };
}

/** What `runLogIndex` needs besides the log: the tool's words, config and render. */
export interface LogIndexRunOptions<F extends string> extends LogIndexCheckOptions {
  /** What more than one subject is called, such as `"decisions"`. */
  readonly plural: string;
  /** The JSON document's `format`, such as `"adr-index/v1"`. */
  readonly format: F;
  /** `[log] index`; anything but `"committed"` is a `UsageError`. */
  readonly index: string;
  /** `[policy] auto_commit`: whether to commit when the options don't say. */
  readonly autoCommit: boolean;
  /** `[commit] subject`. */
  readonly commitSubject: CommitTemplate;
  /** The commit message's title and `{action}`, such as `INDEX_TITLE` and `INDEX_ACTION`. */
  readonly title: string;
  readonly action: string;
}

/**
 * `<tool> index [--check] [--commit | --no-commit] [-m <message>]` (design 2b §4.5): renders
 * `<root>/index.md` and writes and stages it where the work tree or the index differ. With
 * `commit` (default `autoCommit`) it renders HEAD's tree and commits the file alone when HEAD's
 * copy differs, then refreshes the work tree's copy, which may include other subjects'
 * uncommitted entries. `check` writes nothing and reports `index/*` findings.
 */
export async function runLogIndex<F extends string>(
  log: ToolLog,
  t: LogIndexRunOptions<F>,
  o: ToolWriteOptions & { readonly check?: boolean } = {},
): Promise<IndexRun<F>> {
  return withGitOperation(async () => {
    const path = indexPath(log.layout);
    const root = log.layout.root;
    const check = o.check === true;
    const notes = [...log.notes, ...(o.notes ?? [])];
    if (t.index !== "committed") {
      throw new UsageError(`${t.tool} index needs [log] index = "committed" in ${t.tool}.toml`);
    }
    if (check) {
      if (o.commit === true || (o.message !== undefined && o.message !== null)) {
        throw new UsageError("--check writes nothing; drop --commit and --message");
      }
      const findings = await verifyLog({
        git: log.git,
        kind: log.kind,
        layout: log.layout,
        mode: { type: "full", ...(log.ref === null ? {} : { head: log.ref }) },
        checks: [logIndexCheck(log, t)],
      });
      const doc: LogIndexJson<F> = {
        format: t.format,
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
      throw new UsageError(`${t.tool} index writes the work tree; use --ref only with --check`);
    }
    const { git } = log;
    const commit = o.commit ?? t.autoCommit;
    if (commit && ((await git.identity()) === null || (await git.committerIdentity()) === null)) {
      throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
    }
    const head = await git.resolveCommit("HEAD");
    const render = (tree: TreeReader, history: string | null) => t.render(git, { tree, history });
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
      const doc: LogIndexJson<F> = {
        format: t.format,
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
        renderCommitMessage(t.commitSubject, {
          title: t.title,
          vars: { action: t.action, id: "index.md", display: "index.md", command: "index" },
        }).message;
      sha = await commitWithRecovery(git, {
        message,
        only: [path],
        rerun: indexRerunHint(t.tool),
        after: indexAfterHint(t.tool, t.plural, root),
      });
    }
    // Step 5: other subjects' uncommitted entries go back into the work tree and the index.
    let refreshed = false;
    try {
      const again = await render(worktreeReader(git), sha ?? head);
      if (again !== null) refreshed = await place(again);
    } catch (err) {
      notes.push(`${path} may be stale: ${firstLine(err)}; run ${t.tool} index`);
    }
    const doc: LogIndexJson<F> = {
      format: t.format,
      path,
      check: false,
      fresh,
      written: written ? [path] : [],
      commit: sha,
      findings: [],
      notes,
    };
    return { doc, refreshed };
  });
}
