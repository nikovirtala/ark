import { templateHistoryRef } from "@nikovirtala/ledger";
import {
  type CommandSpec,
  sourcesCommand,
  type ToolCli,
  verifyCommand,
} from "@nikovirtala/ledger/cli";
import { issueKind } from "../kind.js";
import { readDecisionLog, readIssueSources } from "../sources.js";
import { issuesChecks, issueVerifyInputs } from "../verify.js";
import { commentCommand } from "./comment.js";
import { editCommand } from "./edit.js";
import { forCommand } from "./for.js";
import { hooksCommand } from "./hooks.js";
import { indexCommand } from "./index-command.js";
import { initCommand } from "./init.js";
import { closeCommand, reopenCommand, startCommand, stopCommand } from "./lifecycle.js";
import { linkCommand, unlinkCommand } from "./link.js";
import { listCommand } from "./list.js";
import { mcpCommand } from "./mcp.js";
import { newCommand } from "./new.js";
import { openForCli } from "./open.js";
import { readyCommand } from "./ready.js";
import { searchCommand } from "./search.js";
import { assignCommand, labelCommand, scopeCommand } from "./sets.js";
import { showCommand } from "./show.js";
import { workCommand } from "./work.js";

/**
 * ledger's shared `verify`: the issue log and the local decision log as the mode reads them (the
 * index for `--staged`, else the `--ref` tree or the work tree), every check of this version, and
 * `[verify] fail_on`.
 */
const verify: CommandSpec = verifyCommand({
  async open({ io, flags, mode, fetchSources }) {
    const log = await openForCli(io, flags, {
      reader: mode.type === "staged" ? "index" : "worktree",
    });
    const decisions = await readDecisionLog(log);
    const sources = await readIssueSources(log, {
      decisions,
      fetch: fetchSources ? "network" : "cache",
    });
    const configured = log.config?.sources ?? [];
    return {
      git: log.git,
      kind: issueKind,
      layout: log.layout,
      checks: issuesChecks(
        log,
        await templateHistoryRef(log.git, mode),
        sources.logs,
        sources.statuses,
      ),
      failOn: log.issues.failOn,
      notes: [...log.notes, ...sources.notes],
      widenOn: issueVerifyInputs(log, decisions),
      ...(configured.length === 0 ? {} : { sources: sources.statuses }),
    };
  },
});

/** ledger's shared `sources fetch`; issues reads every kind its config accepts. */
const sources: CommandSpec = sourcesCommand({
  format: "issues-sources/v1",
  tool: "issues",
  async open({ io, flags }) {
    const log = await openForCli(io, flags);
    return {
      git: log.git,
      sources: log.config?.sources ?? [],
      skipped: [],
      configPath: log.configPath,
      notes: log.notes,
    };
  },
});

/** The `issues` tool: its commands, for ledger's `runCli`. */
export function issuesCli(version: string): ToolCli {
  return {
    name: "issues",
    version,
    summary: "Issue tracking kept as event logs in git.",
    commands: [
      initCommand(version),
      newCommand,
      editCommand,
      startCommand,
      stopCommand,
      closeCommand,
      reopenCommand,
      assignCommand,
      labelCommand,
      commentCommand,
      linkCommand,
      unlinkCommand,
      scopeCommand,
      indexCommand,
      forCommand,
      readyCommand,
      workCommand,
      listCommand,
      showCommand,
      searchCommand,
      verify,
      sources,
      hooksCommand,
      mcpCommand(version),
    ],
  };
}
