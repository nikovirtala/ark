import { templateHistoryRef } from "@nikovirtala/ledger";
import { type ToolCli, verifyCommand } from "@nikovirtala/ledger/cli";
import { adrKind } from "../kind.js";
import { adrChecks } from "../verify.js";
import { listCommand } from "./list.js";
import { openForCli } from "./open.js";
import { showCommand } from "./show.js";

/**
 * ledger's shared `verify`: the log as the mode reads it (the index for `--staged`, else the
 * `--ref` tree or the work tree), every phase-1 check, and `[verify] fail_on`.
 */
const verify = verifyCommand({
  async open({ io, flags, mode }) {
    const log = await openForCli(io, flags, {
      reader: mode.type === "staged" ? "index" : "worktree",
    });
    return {
      git: log.git,
      kind: adrKind,
      layout: log.layout,
      checks: adrChecks(log, await templateHistoryRef(log.git, mode)),
      failOn: log.adr.failOn,
      notes: log.notes,
    };
  },
});

/** The `adr` tool: its commands, for ledger's `runCli`. */
export function adrCli(version: string): ToolCli {
  return {
    name: "adr",
    version,
    summary: "Architecture decision records kept as event logs in git.",
    commands: [listCommand, showCommand, verify],
  };
}
