import type { JsonValue } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { numberingNote, readDecisions } from "../log.js";
import { searchDecisions } from "../search.js";
import { notesWith, openForCli } from "./open.js";
import { searchText } from "./text.js";

/** `adr search <query>… [--all]` (design §8.2): words are joined, and every one must match. */
export const searchCommand: CommandSpec = {
  name: "search",
  summary: "search decisions' ids, titles, bodies and notes",
  usage: "search <query>… [--all]",
  options: { all: { type: "boolean" } },
  positionals: { min: 1, max: 20, names: ["query"] },
  ref: "read",
  async run({ io, flags, values, positionals }) {
    const read = await readDecisions(await openForCli(io, flags));
    const doc = searchDecisions(read, {
      query: positionals.join(" "),
      includeInactive: values.all === true,
    });
    const notes = [...notesWith(doc.notes, numberingNote(read, { unavailable: false }))];
    if (doc.inactive_omitted > 0) {
      const k = doc.inactive_omitted;
      notes.push(
        `${k === 1 ? "1 inactive decision also matches" : `${k} inactive decisions also match`}; add --all to see them`,
      );
    }
    return { exit: 0, json: doc as unknown as JsonValue, text: searchText(doc), notes };
  },
};
