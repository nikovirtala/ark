import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CommitFailedError,
  commitWithRecovery,
  type EventRef,
  eventPath,
  eventTrailers,
  type Finding,
  firstLine,
  headBytes,
  headTree,
  holdsText,
  InvalidArgumentError,
  indexPath,
  indexReader,
  overlayTree,
  type RenderedCommit,
  replaceFile,
  saveCommitRecovery,
  stagedEventRefs,
  type Trailer,
  type TreeReader,
  UsageError,
  unstagedIndexText,
  unstagedLogFiles,
  withoutPaths,
  worktreeReader,
  writeEvents,
  writeIndexCopy,
  writeNewFile,
} from "@nikovirtala/ledger";
import type { IssueLog } from "./log.js";
import { INDEX_AFTER, INDEX_BEFORE } from "./log-index.js";
import type { WritePlan } from "./plan.js";

type Git = IssueLog["git"];

/** Renders the log's index for `tree`, which builds on `history`; `null` when unnumbered. */
export type IndexRender = (tree: TreeReader, history: string | null) => Promise<string | null>;

/** What the editor step decided. */
export interface AfterStage {
  /** Draft lint findings to report instead of `plan.findings`; `null` keeps `plan.findings`. */
  readonly findings: readonly Finding[] | null;
  /** `false` skips the commit: the files stay written and staged, and `commit` is `null`. */
  readonly commit: boolean;
}

/** What `applyPlan` did. */
export interface AppliedPlan {
  /**
   * Repo-relative paths written: replaced files, then new ones, in write order, then
   * `<root>/index.md` when it was written.
   */
  readonly written: string[];
  readonly commit: string | null;
  readonly findings: readonly Finding[];
  /** Notes about the index ("not updated", "may be stale", unstaged files); `[]` when none. */
  readonly notes: readonly string[];
  /** The message `compose` rendered, or `null` without `compose` or a commit. */
  readonly rendered: RenderedCommit | null;
}

/** What `compose` chooses the commit message from (design §4.2). */
export interface ComposeInput {
  /** The plan's own events, in plan order. */
  readonly plan: readonly EventRef[];
  /** The extra staged event files the commit takes, deduplicated by issue and type. */
  readonly extra: readonly EventRef[];
  /** The commit's tree: HEAD with every `only` path's work-tree bytes. */
  readonly tree: TreeReader;
}

/** The `Issue`/`Issue-Event` trailer keys. */
const TRAILER_KEYS = { subject: "Issue", event: "Issue-Event" } as const;

/**
 * What the recovery hint says about rerunning a write command after `git commit` failed: the
 * change is already in the log, so a rerun is refused, writes nothing or writes it again.
 */
export const WRITE_RERUN =
  "Don't run the command again: the log already holds the change, so a rerun would be refused, do nothing, or write it a second time.";

const isYaml = (path: string) => /\.ya?ml$/.test(path);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * The paths a `--commit` of `plan` takes: `plan.commitScope`, widened by every issue reachable
 * from `plan.subject` whose `opened` event isn't in `HEAD` (planned, staged as added or
 * untracked) with its events directory, description and template, as adr's commit scope takes
 * every involved subject's. References are followed from each issue whose events directory is in
 * the scope, since all its staged events join the commit. A committed issue adds nothing, so an
 * unstaged edit of its description never blocks or joins. An uncommitted issue without a
 * description is a `UsageError`: its `opened` event would leave `body/missing` at the commit.
 */
async function commitScopeOf(
  git: Git,
  plan: WritePlan,
): Promise<{ scope: string[]; eventDirs: string[] }> {
  const stage = new Set(plan.stage);
  const opened = sorted(
    Object.values(plan.reach).flatMap((r) => (r.opened === null ? [] : [r.opened])),
  );
  const fresh = new Set([
    ...opened.filter((p) => stage.has(p)),
    ...(await git.stagedPaths(opened, { addedOnly: true })),
    ...(await git.untrackedPaths(opened)),
  ]);
  const paths = new Set(plan.commitScope);
  const dirs = new Set(plan.eventDirs);
  const seen = new Set<string>();
  const queue = [plan.subject];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const r = Object.hasOwn(plan.reach, id) ? plan.reach[id] : undefined;
    if (r === undefined || seen.has(id)) continue;
    seen.add(id);
    if (r.opened !== null && fresh.has(r.opened)) {
      if (r.bodies.length === 0) {
        throw new UsageError(`${r.opened} has no description; restore it, or run without --commit`);
      }
      dirs.add(r.dir);
      for (const b of r.bodies) paths.add(b);
      if (r.template !== null) paths.add(r.template);
    }
    if (dirs.has(r.dir)) queue.push(...r.refs);
  }
  return { scope: sorted([...paths, ...dirs]), eventDirs: sorted(dirs) };
}

/**
 * A write leaves the work tree's render of `index.md` (`staged`) staged, and it lists issue files
 * that may not be staged. When some aren't and the index's own render differs, the next plain
 * commit's hook fails; the note says so, as its `index/stale` finding does. `null` otherwise, or
 * when that render fails. adr's `unstagedIndexNote`.
 */
async function unstagedIndexNote(
  log: IssueLog,
  at: string,
  staged: string,
  history: string | null,
  render: IndexRender,
): Promise<string | null> {
  const files = await unstagedLogFiles(log.git, log.layout);
  if (files.length === 0) return null;
  const own = await render(await indexReader(log.git), history).catch(() => null);
  if (own === null || own === staged) return null;
  return `${unstagedIndexText(at, files, "issue")}; git add them before you commit, or move them out of the work tree and run issues index`;
}

/**
 * Applies a plan: refuses a commit whose scope (`commitScopeOf`: the plan's, plus the files of
 * reached issues not yet in `HEAD`) has unstaged or untracked paths, writes replacements and new
 * files (removing them again if a write fails), writes the events, stages them, runs
 * `afterStage`, and commits `plan.stage` plus the already-staged files of the scope with `--only`
 * and exact trailers. A failed `git commit` throws `CommitFailedError` with the manual command.
 *
 * With `index` (`[log] index = "committed"`), `<root>/index.md` is kept fresh with adr 2b's steps
 * (packages/adr/src/write.ts `applyPlan`, design 2b §4.5 and the binding addendum after review
 * 6): rendered before anything is written from the tree the commit will hold, placed inside the
 * rollback where HEAD's copy decides, rendered again after the editor step from the work-tree
 * bytes of every `only` path (an edited `# ` heading changes the title), committed with the
 * batch, and refreshed from the work tree afterwards.
 */
export async function applyPlan(
  log: IssueLog,
  plan: WritePlan,
  o: {
    readonly commit: boolean;
    /** The commit message, without trailers; this or `compose` is required when committing. */
    readonly message?: string;
    /** Chooses the commit message once the extra staged events are known (?6). */
    readonly compose?: (c: ComposeInput) => RenderedCommit | Promise<RenderedCommit>;
    /** `message` is the user's own: append the trailers to its own trailer block, if it ends in one. */
    readonly mergeTrailers?: boolean;
    /**
     * Runs after staging (the editor step of `new`), with the scope a commit takes, so its
     * late-change check covers the reached issues' files too.
     */
    readonly afterStage?: (scope: readonly string[]) => Promise<AfterStage>;
    /** Renders the log's index; given only when the log keeps a committed index. */
    readonly index?: IndexRender;
  },
): Promise<AppliedPlan> {
  const { git } = log;
  if (o.commit && o.message === undefined && o.compose === undefined) {
    throw new InvalidArgumentError("applyPlan needs a message to commit");
  }
  if (o.message !== undefined && o.compose !== undefined) {
    throw new InvalidArgumentError("applyPlan takes a message or compose, not both");
  }
  const stage = new Set(plan.stage);
  // Step 0: ?5's commit scope comes first, so the index render below sees reached descriptions.
  const scope = o.commit ? await commitScopeOf(git, plan) : null;
  if (scope !== null) {
    const unstaged = new Set(await git.unstagedPaths(scope.scope));
    const dirs = new Set(scope.eventDirs);
    const untracked = new Set([
      ...(await git.untrackedPaths(scope.scope.filter((p) => !dirs.has(p)))),
      ...(await git.untrackedPaths(scope.eventDirs)).filter(isYaml),
    ]);
    const dirty = sorted([...unstaged, ...untracked]).filter((p) => !stage.has(p));
    const [first] = dirty;
    if (first !== undefined) {
      throw new UsageError(
        unstaged.has(first)
          ? `${first} has unstaged changes; stage or discard them, or run without --commit`
          : `${first} is not tracked; git add it, or run without --commit`,
      );
    }
  }

  // Step 1: render before anything is written, so a projection error leaves nothing behind. A
  // committing write renders the tree `git commit --only` builds: HEAD (or nothing) with every
  // `only` path's bytes, `plan.files`' for new files (`fromWork`: the work tree's, after staging).
  const root = log.layout.root;
  const at = indexPath(log.layout);
  const notes: string[] = [];
  const head = await git.resolveCommit("HEAD");
  const extraOf = async () =>
    scope === null ? [] : (await git.stagedPaths(scope.scope)).filter((p) => !stage.has(p));
  const commitTree = async (extra: readonly string[], fromWork: boolean): Promise<TreeReader> => {
    const work = worktreeReader(git);
    const files: Record<string, Uint8Array> = {};
    const gone = new Set<string>();
    for (const p of sorted([...plan.stage, ...extra])) {
      const bytes = fromWork
        ? await work.read(p)
        : (plan.files[p] ?? plan.replace?.[p]?.bytes ?? (await work.read(p)));
      if (bytes === null) gone.add(p);
      else files[p] = bytes;
    }
    return withoutPaths(overlayTree(await headTree(git, head), files), gone);
  };
  const extra0 = o.commit && o.index !== undefined ? await extraOf() : [];
  let text: string | null = null;
  if (o.index !== undefined) {
    const tree = o.commit
      ? await commitTree(extra0, false)
      : overlayTree(worktreeReader(git), { ...plan.files, ...replaceBytes(plan) });
    text = await o.index(tree, head);
    if (text === null) {
      notes.push(
        `${at} not updated: numbers need history in this shallow clone; run git fetch --unshallow, then issues index`,
      );
    }
  }

  const toStage: string[] = [];
  // Assigned in the closures below, so typed without narrowing.
  let indexWritten = false as boolean;
  let indexOld = null as Uint8Array | null;
  let indexInCommit = false as boolean;
  /** Brings the work-tree copy to `t` and stages it (now, or with the batch) where they differ. */
  const refresh = async (t: string, now: boolean): Promise<boolean> => {
    const r = await writeIndexCopy(git, at, t);
    if (r.wrote && !indexWritten) indexOld = r.old;
    indexWritten ||= r.wrote;
    if (r.stage) {
      if (now) await git.add([at]);
      else toStage.push(at);
    }
    return r.wrote || r.stage;
  };
  /** Step 2's rules: committing, HEAD's copy decides; otherwise the work tree and the index. */
  const place = async (t: string, committing: boolean, now: boolean): Promise<void> => {
    if (!committing) {
      await refresh(t, now);
      return;
    }
    indexInCommit = !holdsText(await headBytes(git, at), t);
    if (indexInCommit) await refresh(t, now);
  };

  const eventPaths = new Set(plan.events.map((e) => eventPath(log.layout, e)));
  const written: string[] = [];
  const replaced: string[] = [];
  try {
    for (const [path, r] of Object.entries(plan.replace ?? {})) {
      await replaceFile(git, path, r.bytes, { expected: r.expected });
      replaced.push(path);
    }
    for (const [path, bytes] of Object.entries(plan.files)) {
      if (eventPaths.has(path)) continue;
      await writeNewFile(git, path, bytes, { stage: false });
      written.push(path);
    }
    // Step 2: place inside the rollback, so a failure restores the old copy.
    if (text !== null) await place(text, o.commit, false);
    await writeEvents(git, log.layout, plan.events, { kind: log.compiled, stage: false });
  } catch (err) {
    const top = git.root ?? "";
    if (indexWritten) {
      if (indexOld === null) await rm(join(top, at), { force: true });
      else await writeFile(join(top, at), indexOld);
    }
    for (const path of written) await rm(join(top, path), { force: true });
    for (const path of replaced) {
      const r = plan.replace?.[path];
      if (r !== undefined) {
        await replaceFile(git, path, r.expected, { expected: r.bytes }).catch(() => {});
      }
    }
    throw err;
  }
  // Step 3: stage the batch, and the index when placed.
  await git.add([...plan.stage, ...toStage]);
  /** The work tree's render that ends up staged, and the commit it builds on. */
  let stagedIndex: { readonly text: string; readonly history: string | null } | null =
    !o.commit && text !== null ? { text, history: head } : null;

  let findings = plan.findings;
  let commit = o.commit;
  if (o.afterStage !== undefined) {
    const after = await o.afterStage(scope?.scope ?? plan.commitScope);
    findings = after.findings ?? plan.findings;
    commit = commit && after.commit;
  }

  const stale = (err: unknown) => `${at} may be stale: ${firstLine(err)}; run issues index`;
  let sha: string | null = null;
  let rendered: RenderedCommit | null = null;
  if (commit && scope !== null) {
    const extra = await extraOf();
    const extraRefs = stagedEventRefs(log.layout, extra);
    const planRefs = plan.events.map((e) => ({ subject: e.subject, type: e.type }));
    rendered =
      o.compose === undefined
        ? null
        : await o.compose({
            plan: planRefs,
            extra: extraRefs,
            tree: await commitTree(extra, true),
          });
    const message = rendered?.message ?? o.message ?? "";
    const mergeTrailers = o.mergeTrailers === true;
    // One pair per (issue, type), so three staged links give one `linked` pair (?6); `Issue:`
    // alone (edit) only when no pair names the issue.
    const pairs = eventTrailers([...extraRefs, ...planRefs], TRAILER_KEYS);
    const named = new Set(pairs.filter(([k]) => k === "Issue").map(([, v]) => v));
    const trailers: Trailer[] = [
      ...pairs,
      ...(plan.events.length === 0
        ? plan.trailers.filter(([k, v]) => k !== "Issue" || !named.has(v))
        : []),
    ];
    if (text !== null && o.index !== undefined && o.afterStage !== undefined) {
      // Step 4: after the editor step every `only` path's work-tree bytes are what the commit
      // takes (an edited heading changes the title), so render that tree again. This differs
      // from adr's step 4, which renders again only when the staged events changed.
      try {
        const again = await o.index(await commitTree(extra, true), head);
        if (again !== null) await place(again, true, true);
      } catch (err) {
        const recovery = await saveCommitRecovery(git, {
          message,
          mergeTrailers,
          trailers,
          only: sorted([...plan.stage, ...extra, at]),
        });
        throw new CommitFailedError(
          {
            recovery,
            headline: `${at} couldn't be refreshed: ${firstLine(err)}`,
            detail: "",
            rerun: WRITE_RERUN,
            before: INDEX_BEFORE(root),
            after: null,
            notes,
          },
          { cause: err },
        );
      }
    }
    try {
      sha = await commitWithRecovery(git, {
        message,
        mergeTrailers,
        trailers,
        only: sorted([...plan.stage, ...extra, ...(indexInCommit ? [at] : [])]),
        rerun: WRITE_RERUN,
        after: indexInCommit ? INDEX_AFTER(root) : null,
      });
    } catch (err) {
      throw err instanceof CommitFailedError ? err.withNotes(notes) : err;
    }
    // Step 5: the commit's render leaves out other issues' uncommitted entries; the work tree
    // and the index get them back.
    if (text !== null && o.index !== undefined) {
      try {
        const again = await o.index(worktreeReader(git), sha);
        if (again !== null) {
          await refresh(again, true);
          stagedIndex = { text: again, history: sha };
        }
      } catch (err) {
        notes.push(stale(err));
      }
    }
  } else if (o.commit && text !== null && o.index !== undefined) {
    // Step 4: the editor step turned the commit off, so the index must match the work tree.
    try {
      const again = await o.index(worktreeReader(git), head);
      if (again !== null) {
        await refresh(again, true);
        stagedIndex = { text: again, history: head };
      }
    } catch (err) {
      notes.push(stale(err));
    }
  }
  if (stagedIndex !== null && o.index !== undefined) {
    const { text: t, history } = stagedIndex;
    const note = await unstagedIndexNote(log, at, t, history, o.index);
    if (note !== null) notes.push(note);
  }
  return {
    written: [
      ...Object.keys(plan.replace ?? {}),
      ...Object.keys(plan.files),
      ...(indexWritten ? [at] : []),
    ],
    commit: sha,
    findings,
    notes,
    rendered,
  };
}

/** The new bytes of each file a plan replaces. */
const replaceBytes = (plan: WritePlan): Record<string, Uint8Array> =>
  Object.fromEntries(Object.entries(plan.replace ?? {}).map(([p, r]) => [p, r.bytes]));
