import type { JsonValue } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { initDecisionLog } from "../init.js";
import { openForCli } from "./open.js";
import { initText } from "./text.js";

/** `adr init [--template <name>]… [--commit | --no-commit] [-m <message>]` (design §6.2). */
export const initCommand: CommandSpec = {
  name: "init",
  summary: "set up a decision log: a config file and starter templates",
  usage: "init [--template <name>]… [--commit | --no-commit] [-m <message>]",
  options: { template: { type: "string", multiple: true }, ...COMMIT_OPTIONS },
  positionals: { min: 0, max: 0, names: [] },
  ref: "reject",
  async run({ io, flags, values }) {
    const templates = Array.isArray(values.template) ? (values.template as string[]) : undefined;
    const log = await openForCli(io, flags);
    const doc = await initDecisionLog(log, {
      ...(templates === undefined ? {} : { templates }),
      ...commitChoice(values, { autoCommit: log.adr.autoCommit }),
    });
    return { exit: 0, json: doc as unknown as JsonValue, text: initText(doc), notes: doc.notes };
  },
};
