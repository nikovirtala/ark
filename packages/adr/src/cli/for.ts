import type { JsonValue } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { readDecisions } from "../log.js";
import { decisionsFor } from "../scope.js";
import { openForCli } from "./open.js";
import { forText } from "./text.js";

/** `adr for <path>… [--ref <ref>]` (design §6.9): the decisions that govern each file. */
export const forCommand: CommandSpec = {
  name: "for",
  summary: "list the decisions that govern files, by scope glob and code anchor",
  usage: "for <path>…",
  options: {},
  positionals: { min: 1, max: 100, names: ["path"] },
  ref: "read",
  async run({ io, flags, positionals }) {
    const log = await openForCli(io, flags);
    const read = await readDecisions(log);
    const doc = await decisionsFor(read, log, { paths: positionals, cwd: io.cwd });
    const display = (id: string) => read.projection.views.get(id)?.display ?? id;
    return {
      exit: 0,
      json: doc as unknown as JsonValue,
      text: forText(doc, display, read.adr.anchorKeyword),
      notes: doc.notes,
    };
  },
};
