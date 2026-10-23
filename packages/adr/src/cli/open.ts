import type { CliIO, GlobalFlags } from "@nikovirtala/ledger/cli";
import { type DecisionLog, openDecisionLog } from "../log.js";

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
