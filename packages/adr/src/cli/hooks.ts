import { type CommandSpec, hooksCommand as sharedHooksCommand } from "@nikovirtala/ledger/cli";
import {
  addHookTrailers,
  installDecisionHooks,
  printDecisionHooks,
  runPreCommitHook,
  uninstallDecisionHooks,
} from "../hooks.js";
import { openForCli } from "./open.js";

/**
 * `adr hooks install | uninstall | print --manager … | run pre-commit | trailers <message-file>`
 * (design 2b D4, D8, §4.3): adr's git hooks through ledger's shims, shared with other ark tools.
 */
export const hooksCommand: CommandSpec = sharedHooksCommand({
  tool: "adr",
  open: ({ io, flags, reader }) =>
    openForCli(io, flags, reader === "index" ? { reader: "index" } : {}),
  install: installDecisionHooks,
  uninstall: uninstallDecisionHooks,
  print: printDecisionHooks,
  preCommit: runPreCommitHook,
  trailers: addHookTrailers,
});
