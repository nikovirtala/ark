import { indexCommand as ledgerIndexCommand } from "@nikovirtala/ledger/cli";
import { runDecisionIndex } from "../log-index.js";
import { openForCli } from "./open.js";

/** `adr index [--check] [--commit | --no-commit] [-m <message>]` (design 2b §4.5). */
export const indexCommand = ledgerIndexCommand({
  tool: "adr",
  noun: "decision",
  async open({ io, flags }) {
    const log = await openForCli(io, flags);
    return {
      autoCommit: log.adr.autoCommit,
      failOn: log.adr.failOn,
      run: (o) => runDecisionIndex(log, o),
    };
  },
});
