import { type JsonValue, resolveAttribution } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { noteDecision } from "../write.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { writeText } from "./text.js";

/** `adr note <decision> <text>` (design §6.6): a note on a decision in any state. */
export const noteCommand: CommandSpec = {
  name: "note",
  summary: "add a note to a decision, in any state",
  usage: "note <decision> <text> [--commit | --no-commit] [-m <message>]",
  options: { ...COMMIT_OPTIONS },
  positionals: { min: 2, max: 2, names: ["decision", "text"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const [input = "", text = ""] = positionals;
    const log = await openForCli(io, flags);
    const { actor, notes } = await resolveAttribution(log.git, { env: io.env });
    const doc = await noteDecision(
      log,
      { id: input, text, actor },
      { ...commitChoice(values, { autoCommit: log.adr.autoCommit }), notes },
    );
    const { display } = await displayAfterWrite(log);
    const v = doc.decision;
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: writeText(doc, display, {
        subject: v === null ? input.trim() : `${display(v.id)}: ${v.title}`,
        number: null,
      }),
      notes: doc.notes,
    };
  },
};
