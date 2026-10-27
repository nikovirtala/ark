import { templateHistoryRef } from "@nikovirtala/ledger";
import { sourcesCommand, type ToolCli, verifyCommand } from "@nikovirtala/ledger/cli";
import { adrKind } from "../kind.js";
import { decisionSourceConfigs, readDecisionSources } from "../sources.js";
import { adrChecks, decisionVerifyInputs } from "../verify.js";
import { acceptCommand } from "./accept.js";
import { deprecateCommand } from "./deprecate.js";
import { forCommand } from "./for.js";
import { hooksCommand } from "./hooks.js";
import { indexCommand } from "./index-command.js";
import { initCommand } from "./init.js";
import { linkCommand } from "./link.js";
import { listCommand } from "./list.js";
import { mcpCommand } from "./mcp.js";
import { newCommand } from "./new.js";
import { noteCommand } from "./note.js";
import { openForCli } from "./open.js";
import { rejectCommand } from "./reject.js";
import { scopeCommand } from "./scope.js";
import { searchCommand } from "./search.js";
import { showCommand } from "./show.js";
import { supersedeCommand } from "./supersede.js";
import { withdrawCommand } from "./withdraw.js";

/**
 * ledger's shared `verify`: the log as the mode reads it (the index for `--staged`, else the
 * `--ref` tree or the work tree), every phase-1 check, and `[verify] fail_on`.
 */
const verify = verifyCommand({
  async open({ io, flags, mode, fetchSources }) {
    const log = await openForCli(io, flags, {
      reader: mode.type === "staged" ? "index" : "worktree",
    });
    const sources = await readDecisionSources(log, {
      fetch: fetchSources ? "network" : "cache",
    });
    return {
      git: log.git,
      kind: adrKind,
      layout: log.layout,
      checks: adrChecks(log, await templateHistoryRef(log.git, mode), sources),
      failOn: log.adr.failOn,
      notes: [...log.notes, ...sources.notes],
      widenOn: decisionVerifyInputs(log),
      ...((log.config?.sources ?? []).length === 0 ? {} : { sources: sources.statuses }),
    };
  },
});

/** ledger's shared `sources fetch`, over the `kind = "adr"` entries of `[[sources]]`. */
const sources = sourcesCommand({
  format: "adr-sources/v1",
  tool: "adr",
  async open({ io, flags }) {
    const log = await openForCli(io, flags);
    return {
      git: log.git,
      ...decisionSourceConfigs(log),
      configPath: log.configPath,
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
    commands: [
      initCommand(version),
      newCommand,
      acceptCommand,
      rejectCommand,
      withdrawCommand,
      deprecateCommand,
      supersedeCommand,
      noteCommand,
      linkCommand,
      scopeCommand,
      indexCommand,
      hooksCommand,
      forCommand,
      listCommand,
      showCommand,
      searchCommand,
      verify,
      sources,
      mcpCommand(version),
    ],
  };
}
