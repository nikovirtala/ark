import { indexCommand as ledgerIndexCommand } from "@nikovirtala/ledger/cli";
import { runIssueIndex } from "../log-index.js";
import { openForCli } from "./open.js";

/** `issues index [--check] [--commit | --no-commit] [-m <message>]`. */
export const indexCommand = ledgerIndexCommand({
  tool: "issues",
  noun: "issue",
  checkHelp: "check that index.md is current instead of writing it",
  async open({ io, flags }) {
    const log = await openForCli(io, flags);
    return {
      autoCommit: log.issues.autoCommit,
      failOn: log.issues.failOn,
      run: (o) => runIssueIndex(log, o),
    };
  },
});
