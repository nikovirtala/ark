import { templateHistoryRef } from "@nikovirtala/ledger";
import { type CommandSpec, type ToolCli, verifyCommand } from "@nikovirtala/ledger/cli";
import { issueKind } from "../kind.js";
import { sourcesNote } from "../log.js";
import { readSourceLogs } from "../sources.js";
import { issuesChecks } from "../verify.js";
import { editCommand } from "./edit.js";
import { initCommand } from "./init.js";
import { listCommand } from "./list.js";
import { newCommand } from "./new.js";
import { openForCli } from "./open.js";
import { showCommand } from "./show.js";

/**
 * ledger's shared `verify`: the issue log and the local decision log as the mode reads them (the
 * index for `--staged`, else the `--ref` tree or the work tree), every check of this version, and
 * `[verify] fail_on`.
 */
const verify: CommandSpec = verifyCommand({
  async open({ io, flags, mode }) {
    const log = await openForCli(io, flags, {
      reader: mode.type === "staged" ? "index" : "worktree",
    });
    const sources = await readSourceLogs(log);
    const note = sourcesNote({ sources: (log.config?.sources ?? []).map((s) => s.name) });
    return {
      git: log.git,
      kind: issueKind,
      layout: log.layout,
      checks: issuesChecks(log, await templateHistoryRef(log.git, mode), sources),
      failOn: log.issues.failOn,
      notes: note === null ? log.notes : [...log.notes, note],
    };
  },
});

/** The `issues` tool: its commands, for ledger's `runCli`. */
export function issuesCli(version: string): ToolCli {
  return {
    name: "issues",
    version,
    summary: "Issue tracking kept as event logs in git.",
    commands: [initCommand, newCommand, editCommand, listCommand, showCommand, verify],
  };
}
