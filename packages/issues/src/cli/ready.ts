import { type JsonValue, resolveAttribution } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { readIssues } from "../log.js";
import { myAddress, readyIssues } from "../views.js";
import { limitOf, openForCli, strings } from "./open.js";
import { readyText } from "./text.js";

/** `issues ready [--mine] [--label <label>]… [--limit <n>]`: work that can be picked up now. */
export const readyCommand: CommandSpec = {
  name: "ready",
  summary: "list work that can be picked up now: open, unblocked, unassigned leaf issues",
  usage: "ready [--mine] [--label <label>]… [--limit <n>]",
  options: {
    mine: { type: "boolean" },
    label: { type: "string", multiple: true },
    limit: { type: "string" },
  },
  positionals: { min: 0, max: 0, names: [] },
  ref: "read",
  async run({ io, flags, values }) {
    const limit = limitOf(values.limit);
    const log = await openForCli(io, flags);
    let mine: string | null = null;
    if (values.mine === true) {
      const { actor } = await resolveAttribution(log.git, { env: io.env });
      mine = myAddress(actor);
    }
    const doc = readyIssues(await readIssues(log), {
      labels: strings(values.label),
      mine,
      limit,
    });
    return { exit: 0, json: doc as unknown as JsonValue, text: readyText(doc), notes: doc.notes };
  },
};
