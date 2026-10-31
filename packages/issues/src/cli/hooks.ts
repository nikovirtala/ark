import { type CommandSpec, hooksCommand as sharedHooksCommand } from "@nikovirtala/ledger/cli";
import {
  addHookTrailers,
  installIssueHooks,
  printIssueHooks,
  runPreCommitHook,
  uninstallIssueHooks,
} from "../hooks.js";
import { openForCli } from "./open.js";

/**
 * `issues hooks install | uninstall | print --manager … | run pre-commit | trailers <message-file>`
 * (adr's command, ADR-0011): issues' git hooks through ledger's shims, shared with other ark tools.
 */
export const hooksCommand: CommandSpec = sharedHooksCommand({
  tool: "issues",
  possessive: "issues'",
  manager: { value: "<manager>", help: "lefthook, husky or pre-commit (hooks print only)" },
  open: ({ io, flags, reader }) =>
    openForCli(io, flags, reader === "index" ? { reader: "index" } : {}),
  install: installIssueHooks,
  uninstall: uninstallIssueHooks,
  print: printIssueHooks,
  preCommit: runPreCommitHook,
  trailers: addHookTrailers,
});
