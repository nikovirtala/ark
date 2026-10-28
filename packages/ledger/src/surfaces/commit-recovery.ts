/**
 * The recovery hint for a `git commit` that fails after a tool wrote and staged its files
 * (design 2b D5): the full message is saved, and the error gives the exact command that makes the
 * commit by hand, because rerunning the tool can't.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommitFailedError, type CommitRecovery, GitError } from "../errors.js";
import { type Git, requireWorkTree, type Trailer } from "../git/git.js";
import { shWord } from "../hooks/snippets.js";

export type { CommitRecovery } from "../errors.js";

/** What a tool commits: `Git.commit`'s options, with `only` required. */
export interface CommitInput {
  readonly message: string;
  readonly trailers?: readonly Trailer[];
  readonly mergeTrailers?: boolean;
  readonly only: readonly string[];
}

const MAX_DETAIL_LINES = 40;
/** A path git would read as a pathspec pattern, or a magic pathspec. */
const PATHSPEC_MAGIC = /[*?[]|^:/;

/**
 * Writes the message `Git.commit` would send, trailers included, to `<git dir>/ark/COMMIT_MSG`
 * (overwriting an earlier one), and builds the command that commits exactly `only` with it:
 * `git -C <top> commit --cleanup=whitespace -F <file> --only -- <paths>`, with
 * `--literal-pathspecs` when a path holds a pathspec character. fs errors propagate.
 */
export async function saveCommitRecovery(git: Git, o: CommitInput): Promise<CommitRecovery> {
  requireWorkTree(git);
  return writeRecovery(git, await git.commitMessage(o), o.only, o.trailers ?? []);
}

/** `saveCommitRecovery` for the message text `git.commitMessage` already gave. */
async function writeRecovery(
  git: Git,
  text: string,
  only: readonly string[],
  trailers: readonly Trailer[],
): Promise<CommitRecovery> {
  const top = requireWorkTree(git);
  const dir = join(git.gitDir, "ark");
  const messageFile = join(dir, "COMMIT_MSG");
  await mkdir(dir, { recursive: true });
  await writeFile(messageFile, text);
  const staged = [...only].sort();
  const literal = staged.some((p) => PATHSPEC_MAGIC.test(p));
  const command = [
    "git",
    ...(literal ? ["--literal-pathspecs"] : []),
    "-C",
    shWord(top),
    "commit",
    "--cleanup=whitespace",
    "-F",
    shWord(messageFile),
    "--only",
    "--",
    ...staged.map(shWord),
  ].join(" ");
  return { staged, messageFile, command, trailers: trailers.map(([k, v]) => [k, v] as const) };
}

/** git's stderr, each line indented two spaces, cut after `MAX_DETAIL_LINES` lines. */
function indentLines(text: string): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") return "";
  const shown = lines.slice(0, MAX_DETAIL_LINES).map((l) => `  ${l}`);
  if (lines.length > MAX_DETAIL_LINES) shown.push("  …");
  return shown.join("\n");
}

/**
 * `git.commit(o)`, turning a failed `git commit` into `CommitFailedError` with the recovery hint:
 * when git exits non-zero and `HEAD` hasn't moved, the message is saved (`saveCommitRecovery`)
 * and the error says what to run. The message is built first (`git.commitMessage`), so the saved
 * file holds exactly the text git was sent, and an error building it is thrown as it is, before
 * anything is committed. `rerun` is the caller's sentence on what running the tool again
 * would do; `after` is a step printed last. Any other error, a commit made despite the failure
 * (`HEAD` moved), or a failure to save the message rethrows git's error, the last with the fs
 * error as its `cause`, so no hint is printed that can't be followed.
 */
export async function commitWithRecovery(
  git: Git,
  o: CommitInput & { readonly rerun: string; readonly after?: string | null },
): Promise<string> {
  const message = await git.commitMessage(o);
  const before = await git.resolveCommit("HEAD");
  try {
    return await git.commit({ message, only: o.only });
  } catch (e) {
    if (!(e instanceof GitError) || e.exitCode === null) throw e;
    if ((await git.resolveCommit("HEAD")) !== before) throw e;
    let recovery: CommitRecovery;
    try {
      recovery = await writeRecovery(git, message, o.only, o.trailers ?? []);
    } catch (fsError) {
      throw new GitError(
        e.message,
        { args: e.args, exitCode: e.exitCode, stderr: e.stderr },
        { cause: fsError },
      );
    }
    const first = e.stderr.trim().split("\n")[0] ?? "";
    throw new CommitFailedError(
      {
        recovery,
        headline: `git commit failed (exit ${e.exitCode})${first === "" ? "" : `: ${first}`}`,
        detail: indentLines(e.stderr),
        rerun: o.rerun,
        before: null,
        after: o.after ?? null,
      },
      { cause: e },
    );
  }
}
