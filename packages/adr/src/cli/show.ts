import type { JsonValue } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { numberingNote, readDecisions, resolveDecision } from "../log.js";
import { showDecision } from "../views.js";
import { notesWith, openForCli } from "./open.js";
import { showText } from "./text.js";

/** `adr show <decision> [--history]` (design §5.6). */
export const showCommand: CommandSpec = {
  name: "show",
  summary: "show a decision with its state header, chain, history and body",
  usage: "show <decision> [--history]",
  options: { history: { type: "boolean" } },
  positionals: { min: 1, max: 1, names: ["decision"] },
  ref: "read",
  async run({ io, flags, values, positionals }) {
    const read = await readDecisions(await openForCli(io, flags));
    const id = resolveDecision(read, positionals[0] ?? "");
    const doc = await showDecision(read, id, { history: values.history === true });
    const display = (s: string) => read.projection.views.get(s)?.display ?? s;
    return {
      exit: 0,
      json: doc as unknown as JsonValue,
      text: showText(doc, display),
      notes: notesWith(doc.notes, numberingNote(read, { unavailable: false })),
    };
  },
};
