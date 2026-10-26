import type { JsonValue } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { initIssueLog } from "../init.js";
import { openForCli, strings } from "./open.js";
import { initText } from "./text.js";

/** `issues init [--template <name>]… [--commit | --no-commit] [-m <message>]`. */
export const initCommand: CommandSpec = {
  name: "init",
  summary: "set up an issue log: a config file and starter templates",
  usage: "init [--template bug|feature|task]… [--commit | --no-commit] [-m <message>]",
  options: { template: { type: "string", multiple: true }, ...COMMIT_OPTIONS },
  positionals: { min: 0, max: 0, names: [] },
  ref: "reject",
  async run({ io, flags, values }) {
    const log = await openForCli(io, flags);
    const doc = await initIssueLog(log, {
      templates: strings(values.template),
      ...commitChoice(values, { autoCommit: log.issues.autoCommit }),
    });
    return { exit: 0, json: doc as unknown as JsonValue, text: initText(doc), notes: doc.notes };
  },
};
