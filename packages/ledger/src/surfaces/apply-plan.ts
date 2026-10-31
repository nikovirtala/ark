/**
 * The apply step a tool's writes share (adr §5.4, design 2b §4.5): refuse a commit whose scope
 * has unstaged or untracked paths, write and stage the plan's files, keep `<root>/index.md` fresh,
 * and commit with exact trailers. A tool binds its trailer keys, its words and its index render.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventEnvelope } from "../envelope/types.js";
import { CommitFailedError, InvalidArgumentError, UsageError } from "../errors.js";
import type { Finding } from "../findings/finding.js";
import type { Trailer } from "../git/git.js";
import { indexReader, overlayTree, type TreeReader, worktreeReader } from "../git/tree.js";
import { eventPath } from "../identity/layout.js";
import { replaceFile, writeEvents, writeNewFile } from "../log/write.js";
import {
  firstLine,
  headBytes,
  headTree,
  holdsText,
  withoutPaths,
  writeIndexCopy,
} from "../log-index/copies.js";
import { indexPath, unstagedIndexText, unstagedLogFiles } from "../log-index/tool-render.js";
import {
  type EventRef,
  eventTrailers,
  type RenderedCommit,
  stagedEventRefs,
} from "./commit-message.js";
import { commitWithRecovery, saveCommitRecovery } from "./commit-recovery.js";
import { indexAfterHint, indexBeforeHint } from "./tool-index.js";
import type { ToolLog } from "./tool-log.js";

/**
 * What `applyPlan` reads of a write plan, computed without touching git or the disk. Each tool's
 * plan extends it with its own views and commit parts.
 */
export interface WritePlan {
  readonly subject: string;
  /** New files, repo-relative path → bytes, in write order: body, materialized template, events. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  /**
   * Existing files to replace, path → the new bytes and the bytes the plan read; written only if
   * the file still holds `expected`.
   */
  readonly replace?: Readonly<
    Record<string, { readonly bytes: Uint8Array; readonly expected: Uint8Array }>
  >;
  readonly events: readonly EventEnvelope[];
  /** Paths to stage: every new or replaced file. */
  readonly stage: readonly string[];
  /** The paths a `--commit` takes and checks for unstaged or untracked changes. Sorted. */
  readonly commitScope: readonly string[];
  /** The events directories in `commitScope`; the rest of `commitScope` are file paths. */
  readonly eventDirs: readonly string[];
  /** The trailers a commit without events takes; one subject/event pair per event otherwise. */
  readonly trailers: readonly Trailer[];
  /** Informational findings the write reports. */
  readonly findings: readonly Finding[];
  /** The write's own notes for the result. */
  readonly notes?: readonly string[];
}

/** What the editor step decided (§5.4 step 4a). */
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

/** What `compose` chooses the commit message from (?6). */
export interface ComposeInput {
  /** The plan's own events, in plan order. */
  readonly plan: readonly EventRef[];
  /** The extra staged event files the commit takes, by file name, deduplicated by subject and type. */
  readonly extra: readonly EventRef[];
  /** The commit's tree: HEAD with every `only` path's bytes (see `afterEditBytes`). */
  readonly tree: TreeReader;
}

/**
 * Renders the log's index for `tree`, which builds on `history` (HEAD, the new commit, or null on
 * an unborn HEAD); `null` when the numbers can't be projected.
 */
export type IndexRender = (tree: TreeReader, history: string | null) => Promise<string | null>;

/** The commit scope `applyPlan` checks and commits: paths, and the events directories among them. */
export interface CommitScope {
  readonly scope: readonly string[];
  readonly eventDirs: readonly string[];
}

/** `applyPlan`'s options: the call's own, then the tool's bindings. */
export interface ApplyPlanOptions<P extends WritePlan = WritePlan> {
  readonly commit: boolean;
  /** The commit message, without trailers; this or `compose` is required when committing. */
  readonly message?: string;
  /** `message` is the user's own: append the trailers to its own trailer block, if it ends in one. */
  readonly mergeTrailers?: boolean;
  /**
   * Renders the commit message once the extra staged events are known (?6), instead of
   * `message`. Exclusive with `message`.
   */
  readonly compose?: (c: ComposeInput) => RenderedCommit | Promise<RenderedCommit>;
  /**
   * Runs after staging (the editor step), with the scope a commit takes, so its late-change check
   * covers every path of the commit.
   */
  readonly afterStage?: (scope: readonly string[]) => Promise<AfterStage>;
  /**
   * Renders the log's index; given only when the log keeps a committed index (design 2b D2,
   * §4.5).
   */
  readonly index?: IndexRender;
  /** The trailer keys, such as `{ subject: "ADR", event: "ADR-Event" }`. */
  readonly trailerKeys: { readonly subject: string; readonly event: string };
  /** The tool's command, for the `run <tool> index` hints, such as `"adr"`. */
  readonly tool: string;
  /** What one subject is called in the unstaged-files note, such as `"decision"`. */
  readonly noun: string;
  /** What the subjects are called in the recovery hints, such as `"decisions"`. */
  readonly plural: string;
  /**
   * The commit scope, computed first when committing; default `plan.commitScope` and
   * `plan.eventDirs`. Its errors beat the unstaged-path refusal.
   */
  readonly scope?: (plan: P) => Promise<CommitScope>;
  /**
   * When step 4 renders the index again after the editor step: `"always"`, or
   * `"when-events-change"`, only when the staged event files the commit takes changed.
   */
  readonly rerenderAfterEdit: "always" | "when-events-change";
  /**
   * The bytes of the plan's paths in the tree `compose` gets and step 4 renders: `"plan"`, the
   * plan's own (the work tree's for other paths), or `"worktree"`, the work tree's for every path
   * (an edited heading changes the title). Step 1 always renders the plan's.
   */
  readonly afterEditBytes: "plan" | "worktree";
}

/**
 * What the recovery hint says about rerunning a write command after `git commit` failed (design
 * 2b D5): the batch is already in the log, so a rerun is refused, writes nothing or duplicates it.
 */
export const WRITE_RERUN =
  "Don't run the command again: the log already holds the change, so a rerun would be refused, do nothing, or write it a second time.";

const isYaml = (path: string) => /\.ya?ml$/.test(path);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** The new bytes of each file a plan replaces. */
const replaceBytes = (plan: WritePlan): Record<string, Uint8Array> =>
  Object.fromEntries(Object.entries(plan.replace ?? {}).map(([p, r]) => [p, r.bytes]));

/**
 * A write leaves the work tree's render of `index.md` (`staged`) staged, and it lists subject
 * files that may not be staged. When some aren't and the index's own render differs, the next
 * plain commit's hook fails; the note says so, as its `index/stale` finding does. `null`
 * otherwise, or when that render fails.
 */
export async function unstagedIndexNote(
  log: Pick<ToolLog, "git" | "layout">,
  at: string,
  staged: string,
  history: string | null,
  render: IndexRender,
  words: { readonly tool: string; readonly noun: string },
): Promise<string | null> {
  const files = await unstagedLogFiles(log.git, log.layout);
  if (files.length === 0) return null;
  const own = await render(await indexReader(log.git), history).catch(() => null);
  if (own === null || own === staged) return null;
  return `${unstagedIndexText(at, files, words.noun)}; git add them before you commit, or move them out of the work tree and run ${words.tool} index`;
}

/**
 * Applies a plan (§5.4): refuses a commit whose scope has unstaged or needed untracked paths,
 * writes replacements and new files (removing them again if a write fails), writes the events,
 * stages them, runs `afterStage`, and commits `plan.stage` plus the scope's already-staged files
 * with `--only` and exact trailers. A failed `git commit` throws `CommitFailedError` with the
 * manual command (design 2b D5) and the notes made so far.
 *
 * With `index` (`[log] index = "committed"`), `<root>/index.md` is kept fresh (design 2b §4.5):
 * rendered before anything is written from the tree the commit will hold, placed inside the
 * rollback where HEAD's copy decides, rendered again after the editor step (`rerenderAfterEdit`,
 * `afterEditBytes`), committed with the batch, and refreshed from the work tree afterwards.
 */
export async function applyPlan<P extends WritePlan>(
  log: Pick<ToolLog, "git" | "layout" | "compiled">,
  plan: P,
  o: ApplyPlanOptions<P>,
): Promise<AppliedPlan> {
  const { git } = log;
  if (o.commit && o.message === undefined && o.compose === undefined) {
    throw new InvalidArgumentError("applyPlan needs a message to commit");
  }
  if (o.message !== undefined && o.compose !== undefined) {
    throw new InvalidArgumentError("applyPlan takes a message or compose, not both");
  }
  const stage = new Set(plan.stage);
  // Step 0: the commit scope comes first, so its errors beat the unstaged-path refusal and the
  // index render below sees a widened scope. This check runs before anything is written. It stays
  // correct with an editor in between for the body, which is in `plan.stage` and is re-staged
  // after a successful edit; every other path in the scope (a materialized template, say) is
  // checked again by the editor step once the editor has closed, because `--only` would commit
  // its work-tree content.
  const scope: CommitScope | null = !o.commit
    ? null
    : o.scope === undefined
      ? { scope: plan.commitScope, eventDirs: plan.eventDirs }
      : await o.scope(plan);
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
  const afterEditFromWork = o.afterEditBytes === "worktree";
  const extra0 = o.commit && o.index !== undefined ? await extraOf() : [];
  let text: string | null = null;
  if (o.index !== undefined) {
    const tree = o.commit
      ? await commitTree(extra0, false)
      : overlayTree(worktreeReader(git), { ...plan.files, ...replaceBytes(plan) });
    text = await o.index(tree, head);
    if (text === null) {
      notes.push(
        `${at} not updated: numbers need history in this shallow clone; run git fetch --unshallow, then ${o.tool} index`,
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

  const stale = (err: unknown) => `${at} may be stale: ${firstLine(err)}; run ${o.tool} index`;
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
            tree: await commitTree(extra, afterEditFromWork),
          });
    const message = rendered?.message ?? o.message ?? "";
    const mergeTrailers = o.mergeTrailers === true;
    // One pair per (subject, type), so a staged event of a type the plan writes too adds nothing
    // and three staged links give one pair (?6); the subject's key alone (an edit) only when no
    // pair names the subject.
    const keys = o.trailerKeys;
    const pairs = eventTrailers([...extraRefs, ...planRefs], keys);
    const named = new Set(pairs.filter(([k]) => k === keys.subject).map(([, v]) => v));
    const trailers: Trailer[] = [
      ...pairs,
      ...(plan.events.length === 0
        ? plan.trailers.filter(([k, v]) => k !== keys.subject || !named.has(v))
        : []),
    ];
    const eventsChanged = () =>
      sorted(extra.filter(isYaml)).join("\0") !== sorted(extra0.filter(isYaml)).join("\0");
    if (
      text !== null &&
      o.index !== undefined &&
      o.afterStage !== undefined &&
      (o.rerenderAfterEdit === "always" || eventsChanged())
    ) {
      // Step 4: the editor step ran, so render the tree the commit takes again: other events may
      // be staged now, and with `afterEditBytes: "worktree"` an edited heading changes the title.
      try {
        const again = await o.index(await commitTree(extra, afterEditFromWork), head);
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
            before: indexBeforeHint(o.tool, o.plural, root),
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
        after: indexInCommit ? indexAfterHint(o.tool, o.plural, root) : null,
      });
    } catch (err) {
      // The notes made so far (an index not updated, say) explain the state the hint describes.
      throw err instanceof CommitFailedError ? err.withNotes(notes) : err;
    }
    // Step 5: the commit's render leaves out other subjects' uncommitted entries; the work tree
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
    const note = await unstagedIndexNote(log, at, t, history, o.index, o);
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
