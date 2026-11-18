import { UsageError } from "../errors.js";
import { checkCommitMessage } from "../surfaces/commit-message.js";
import type { CommandOption } from "./run.js";

/** `--commit`/`--no-commit` and `-m/--message`, for every command that can commit. */
export const COMMIT_OPTIONS = {
  commit: {
    type: "boolean",
    help: "commit what the command stages (default: [policy] auto_commit)",
    negatedHelp: "only stage, even with [policy] auto_commit",
  },
  message: {
    type: "string",
    short: "m",
    value: "<message>",
    help: "the commit message; needs a commit",
  },
} as const satisfies Record<string, CommandOption>;

/** The hint for a `--commit` that `[policy] auto_commit = true` makes unnecessary. */
export const REDUNDANT_COMMIT_HINT =
  "--commit isn't needed here: [policy] auto_commit = true commits every write";
// Keyed by the parsed options runCli hands a command, which commands pass to commitChoice as is.
const sinks = new WeakMap<object, string[]>();
/**
 * The hints `commitChoice` gives for `values` from now on, for `runCli` to show a person at a
 * terminal. For other `values`, `commitChoice` gives none.
 */
export function collectHints(values: object): readonly string[] {
  const sink: string[] = [];
  sinks.set(values, sink);
  return sink;
}
/**
 * Whether to commit (`--commit`/`--no-commit` when given, else `autoCommit`) and the
 * `--message` to commit with, checked by `checkCommitMessage`. `--message` without a commit is a
 * `UsageError`. A `--commit` that `autoCommit` already implies adds `REDUNDANT_COMMIT_HINT` to
 * the hints `collectHints` collects for `values`.
 */
export function commitChoice(
  values: Readonly<Record<string, unknown>>,
  o: { readonly autoCommit: boolean },
): { readonly commit: boolean; readonly message: string | null } {
  const commit = typeof values.commit === "boolean" ? values.commit : o.autoCommit;
  if (values.commit === true && o.autoCommit) {
    const sink = sinks.get(values);
    if (sink !== undefined && !sink.includes(REDUNDANT_COMMIT_HINT))
      sink.push(REDUNDANT_COMMIT_HINT);
  }
  if (typeof values.message !== "string") return { commit, message: null };
  if (values.commit === false) throw new UsageError("--message can't be used with --no-commit");
  if (!commit) throw new UsageError("--message needs --commit (or [policy] auto_commit = true)");
  return { commit, message: checkCommitMessage(values.message) };
}
