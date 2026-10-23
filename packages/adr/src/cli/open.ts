import type { CliIO, GlobalFlags } from "@nikovirtala/ledger/cli";
import { type DecisionLog, openDecisionLog, readDecisions } from "../log.js";
import type { Display } from "./text.js";

/**
 * The decision log a command works on: `--root` and `--ref` from the globals, git run with the
 * CLI's environment.
 */
export function openForCli(
  io: CliIO,
  flags: GlobalFlags,
  o: { readonly reader?: "worktree" | "index" } = {},
): Promise<DecisionLog> {
  return openDecisionLog({
    cwd: io.cwd,
    root: flags.root,
    ref: flags.ref,
    ...(o.reader === undefined ? {} : { reader: o.reader }),
    gitOptions: { env: io.env },
  });
}

/**
 * How other decisions display in a write's text, read again from the work tree, like the write
 * result's own views: a commit on the main ref has numbered the decisions it accepted.
 */
export async function displayAfterWrite(log: DecisionLog): Promise<{ readonly display: Display }> {
  const read = await readDecisions(log);
  return { display: (id) => read.projection.views.get(id)?.display ?? id };
}

/** `--commit`/`--no-commit` when given, else `[policy] auto_commit`. */
export function commitRequested(log: DecisionLog, values: Readonly<Record<string, unknown>>) {
  return typeof values.commit === "boolean" ? values.commit : log.adr.autoCommit;
}
