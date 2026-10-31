import {
  type HookManager,
  type HookName,
  installToolHooks,
  type PreCommitHookResult,
  printToolHooks,
  readCommitMessage,
  runPreCommitHook as runToolPreCommitHook,
  stagedEventTrailers,
  type ToolHooksJson,
  toolHookCommands,
  toolHooksResult,
  uninstallToolHooks,
  withGitOperation,
} from "@nikovirtala/ledger";
import type { DecisionLog } from "./log.js";
import { renderDecisionIndex } from "./log-index.js";
import { verifyDecisions } from "./verify.js";
import { followScopeRenames } from "./write.js";

/** `adr hooks … --json` (design 2b §4.3); `hooks run` prints `ledger-findings/v1` instead. */
export type HooksResultJson = ToolHooksJson<"adr-hooks/v1">;

const SPEC = { tool: "adr", format: "adr-hooks/v1" } as const;

/**
 * adr's command per hook (design 2b D4), after `adr`. `--root <root>` comes first only when the
 * root can't be found without it: no `<repo>/adr.toml` names it and it isn't `docs/adr`. So the
 * hooks see the same config as a plain `adr` run, and never print the root-override note.
 */
export function decisionHookCommands(
  log: DecisionLog,
): Partial<Record<HookName, readonly string[]>> {
  return toolHookCommands(log, "adr");
}

/**
 * Registers adr's four commands in ledger's shims, one per hook and shared with other ark tools
 * (design 2b D4). With `core.hooksPath` set or a foreign hook file present, it writes the rest and
 * then throws `HookConflictError` (exit 2), naming each conflict and the `print` command.
 */
export function installDecisionHooks(log: DecisionLog): Promise<HooksResultJson> {
  return installToolHooks(log, SPEC);
}

/** Removes adr from every shim; a shim left with no tool is deleted. */
export function uninstallDecisionHooks(log: DecisionLog): Promise<HooksResultJson> {
  return uninstallToolHooks(log, SPEC);
}

/** The config to paste into a hook manager instead of installing shims. */
export function printDecisionHooks(log: DecisionLog, manager: HookManager): HooksResultJson {
  return printToolHooks(log, SPEC, manager);
}

const KEYS = { subject: "ADR", event: "ADR-Event" } as const;

/**
 * The `commit-msg` step (P1 §7.1): appends one `ADR`/`ADR-Event` pair per decision and event type
 * among the staged added event files of the log (`eventTrailers`, ?6), in path order, keeping
 * pairs another tool already added (`ifExists: "add"`). It does nothing for a message that
 * already has an `ADR-Event:` trailer (an `adr … --commit` message), or during a merge, whose
 * events came with their own commits' trailers. Throws `UsageError` when the file is missing.
 */
export function addHookTrailers(log: DecisionLog, messageFile: string): Promise<HooksResultJson> {
  return withGitOperation(async () => {
    const { git, layout } = log;
    const message = await readCommitMessage(git, messageFile, KEYS);
    if (message === null) return toolHooksResult(log, SPEC, "trailers", null);
    const { trailers } = await stagedEventTrailers(git, layout, KEYS);
    await git.appendTrailers(message.file, trailers, { ifExists: "add" });
    return toolHooksResult(log, SPEC, "trailers", null, { trailers });
  });
}

/**
 * `adr hooks run pre-commit` (design 2b D8, `runPreCommitHook` in ledger): rename following, then
 * the index, then `verify --staged`, stopping at the first step that fails. `worktree` must be
 * opened with the work-tree reader, because rename following writes through `write()`; `index`
 * with the index reader, for the config as staged, the index render and verify.
 */
export function runPreCommitHook(o: {
  readonly worktree: DecisionLog;
  readonly index: DecisionLog;
  readonly env: NodeJS.ProcessEnv;
}): Promise<PreCommitHookResult> {
  const { index } = o;
  const config = index.adr;
  return runToolPreCommitHook({
    ...o,
    tool: "adr",
    config,
    followRenames: followScopeRenames,
    renderIndex: (git, at) =>
      renderDecisionIndex(git, { layout: index.layout, adr: config, ...at }),
    verify: () => verifyDecisions(index, { type: "staged" }),
  });
}
