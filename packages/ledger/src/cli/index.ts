/**
 * CLI scaffolding for ledger tools (`@nikovirtala/ledger/cli`): shared global flags, help, exit
 * codes 0/1/2, the `ark-error/v1` document and the `verify` command. Kept out of the root entry,
 * so importing a kind never loads CLI code.
 *
 * The error classes are re-exported so users of this entry share the root entry's classes.
 */
export { LedgerError, UsageError } from "../errors.js";
export { COMMIT_OPTIONS, commitChoice } from "./commit.js";
export type { GlobalFlags } from "./flags.js";
export { type CliIO, processIO } from "./output.js";
export { confirm } from "./prompt.js";
export { type CommandSpec, type Outcome, runCli, type ToolCli } from "./run.js";
export { type VerifyCommandOptions, verifyCommand } from "./verify-command.js";
