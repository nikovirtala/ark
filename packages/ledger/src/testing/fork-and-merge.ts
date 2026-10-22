import { InvalidArgumentError } from "../errors.js";
import { requireWorkTree } from "../git/git.js";
import type { TempRepo } from "./temp-repo.js";

/** The temporary branch the `right` side is built on; deleted again before returning. */
const RIGHT_BRANCH = "fork-and-merge/right";

export interface ForkAndMergeOptions {
  /** Runs on the current branch, from the fork point. */
  readonly left: (r: TempRepo) => Promise<void>;
  /** Runs on a temporary branch, from the fork point. */
  readonly right: (r: TempRepo) => Promise<void>;
  /** `"merge"` (default): a `--no-ff` merge of right into left. `"rebase"`: right rebased onto left, then fast-forwarded. */
  readonly strategy?: "merge" | "rebase";
}

export interface ForkAndMergeResult {
  /** The fork point: HEAD when `forkAndMerge` was called. */
  readonly base: string;
  /** The tip of the left side. */
  readonly left: string;
  /** The tip of the right side, before any rebase. */
  readonly right: string;
  /** HEAD of the current branch after the merge or rebase. */
  readonly merged: string;
}

/**
 * Forks the current branch at HEAD, builds both sides and joins them again, leaving the current
 * branch checked out at the result. Each side's callback may commit itself; anything it leaves
 * uncommitted (new, modified or deleted files) is committed as one `left` or `right` commit.
 * A conflicting merge or rebase is aborted and its `GitError` rethrown.
 */
export async function forkAndMerge(
  repo: TempRepo,
  o: ForkAndMergeOptions,
): Promise<ForkAndMergeResult> {
  const git = repo.git;
  requireWorkTree(git);
  const base = await git.resolveCommit("HEAD");
  if (base === null) throw new InvalidArgumentError("forkAndMerge needs a commit at HEAD");
  const branch = await git.run(["symbolic-ref", "-q", "--short", "HEAD"], { okCodes: [0, 1] });
  if (branch.code !== 0) throw new InvalidArgumentError("forkAndMerge needs a branch at HEAD");
  const current = Buffer.from(branch.stdout).toString().trim();

  const side = async (label: string, build: (r: TempRepo) => Promise<void>): Promise<string> => {
    await build(repo);
    const status = await git.run(["status", "--porcelain", "--untracked-files=all"]);
    if (status.stdout.length > 0) {
      await git.run(["add", "-A"]);
      await repo.commit(label);
    }
    return head(repo);
  };

  await repo.checkout(RIGHT_BRANCH, { create: true });
  const right = await side("right", o.right);
  await repo.checkout(current);
  const left = await side("left", o.left);

  try {
    if (o.strategy === "rebase") {
      await repo.checkout(RIGHT_BRANCH);
      try {
        // Rebased commits keep their author date as committer date, so a TempRepo clock stays in effect.
        await git.run(["rebase", "-q", "--committer-date-is-author-date", current]);
      } catch (e) {
        await git.run(["rebase", "--abort"], { okCodes: [0, 128] });
        throw e;
      }
      await repo.checkout(current);
      await git.run(["merge", "-q", "--ff-only", RIGHT_BRANCH]);
    } else {
      try {
        await repo.merge(RIGHT_BRANCH, { noFf: true, message: "merge right" });
      } catch (e) {
        await git.run(["merge", "--abort"], { okCodes: [0, 128] });
        throw e;
      }
    }
  } finally {
    await repo.checkout(current);
    await git.run(["branch", "-q", "-D", RIGHT_BRANCH]);
  }
  return { base, left, right, merged: await head(repo) };
}

async function head(repo: TempRepo): Promise<string> {
  const sha = await repo.git.resolveCommit("HEAD");
  if (sha === null) throw new InvalidArgumentError("HEAD does not resolve");
  return sha;
}
