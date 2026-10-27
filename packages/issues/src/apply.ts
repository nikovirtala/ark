import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyPath,
  commitWithRecovery,
  eventPath,
  type Finding,
  InvalidArgumentError,
  parseEventFileName,
  replaceFile,
  type Trailer,
  UsageError,
  writeEvents,
  writeNewFile,
} from "@nikovirtala/ledger";
import type { IssueLog } from "./log.js";
import type { WritePlan } from "./plan.js";

type Git = IssueLog["git"];

/** What the editor step decided. */
export interface AfterStage {
  /** Draft lint findings to report instead of `plan.findings`; `null` keeps `plan.findings`. */
  readonly findings: readonly Finding[] | null;
  /** `false` skips the commit: the files stay written and staged, and `commit` is `null`. */
  readonly commit: boolean;
}

/** What `applyPlan` did. */
export interface AppliedPlan {
  /** Repo-relative paths written: replaced files, then new ones, in write order. */
  readonly written: string[];
  readonly commit: string | null;
  readonly findings: readonly Finding[];
}

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
 * Applies a plan, as adr's `applyPlan` does without the index: refuses a commit whose scope
 * (`commitScopeOf`: the plan's, plus the files of reached issues not yet in `HEAD`) has unstaged
 * or untracked paths, writes replacements and new files (removing them again if a write
 * fails), writes the events, stages them, runs `afterStage`, and commits `plan.stage` plus the
 * already-staged files of the scope with `--only` and exact trailers. A failed `git commit` throws
 * `CommitFailedError` with the manual command.
 */
export async function applyPlan(
  log: IssueLog,
  plan: WritePlan,
  o: {
    readonly commit: boolean;
    /** The commit message, without trailers; required when committing. */
    readonly message?: string;
    /** `message` is the user's own: append the trailers to its own trailer block, if it ends in one. */
    readonly mergeTrailers?: boolean;
    readonly afterStage?: () => Promise<AfterStage>;
  },
): Promise<AppliedPlan> {
  const { git } = log;
  if (o.commit && o.message === undefined) {
    throw new InvalidArgumentError("applyPlan needs a message to commit");
  }
  const stage = new Set(plan.stage);
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
    await writeEvents(git, log.layout, plan.events, { kind: log.compiled, stage: false });
  } catch (err) {
    const top = git.root ?? "";
    for (const path of written) await rm(join(top, path), { force: true });
    for (const path of replaced) {
      const r = plan.replace?.[path];
      if (r !== undefined) {
        await replaceFile(git, path, r.expected, { expected: r.bytes }).catch(() => {});
      }
    }
    throw err;
  }
  await git.add([...plan.stage]);

  let findings = plan.findings;
  let commit = o.commit;
  if (o.afterStage !== undefined) {
    const after = await o.afterStage();
    findings = after.findings ?? plan.findings;
    commit = commit && after.commit;
  }

  let sha: string | null = null;
  if (commit && scope !== null) {
    const extra = (await git.stagedPaths(scope.scope)).filter((p) => !stage.has(p));
    const staged: Trailer[] = extra.filter(isYaml).flatMap((p): Trailer[] => {
      const c = classifyPath(log.layout, p);
      const name = c.area === "event" && !c.file.includes("/") ? parseEventFileName(c.file) : null;
      return c.area === "event" && c.subject !== null && name !== null
        ? [
            ["Issue", c.subject],
            ["Issue-Event", name.type],
          ]
        : [];
    });
    sha = await commitWithRecovery(git, {
      message: o.message ?? "",
      mergeTrailers: o.mergeTrailers === true,
      trailers: [...staged, ...plan.trailers],
      only: sorted([...plan.stage, ...extra]),
      rerun: WRITE_RERUN,
    });
  }
  return {
    written: [...Object.keys(plan.replace ?? {}), ...Object.keys(plan.files)],
    commit: sha,
    findings,
  };
}
