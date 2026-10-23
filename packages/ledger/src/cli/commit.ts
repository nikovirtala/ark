import type { ParseArgsOptionsConfig } from "node:util";
import { UsageError } from "../errors.js";
import { checkCommitMessage } from "../surfaces/commit-message.js";

/** `--commit`/`--no-commit` and `-m/--message`, for every command that can commit. */
export const COMMIT_OPTIONS = {
  commit: { type: "boolean" },
  message: { type: "string", short: "m" },
} as const satisfies ParseArgsOptionsConfig;

/**
 * Whether to commit (`--commit`/`--no-commit` when given, else `autoCommit`) and the
 * `--message` to commit with, checked by `checkCommitMessage`. `--message` without a commit is a
 * `UsageError`.
 */
export function commitChoice(
  values: Readonly<Record<string, unknown>>,
  o: { readonly autoCommit: boolean },
): { readonly commit: boolean; readonly message: string | null } {
  const commit = typeof values.commit === "boolean" ? values.commit : o.autoCommit;
  if (typeof values.message !== "string") return { commit, message: null };
  if (values.commit === false) throw new UsageError("--message can't be used with --no-commit");
  if (!commit) throw new UsageError("--message needs --commit (or [policy] auto_commit = true)");
  return { commit, message: checkCommitMessage(values.message) };
}
