import { type JsonValue, resolveAttribution } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { linkDecision } from "../write.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { writeText } from "./text.js";

/** `adr link <decision> <target> [--rel <rel>]` (design §6.7): a typed link, in any state. */
export const linkCommand: CommandSpec = {
  name: "link",
  summary: "link a decision to another one, here or in a configured source",
  usage:
    "link <decision> <target> [--rel relates-to|refines|depends-on] [--commit | --no-commit] [-m <message>]",
  options: { rel: { type: "string" }, ...COMMIT_OPTIONS },
  positionals: { min: 2, max: 2, names: ["decision", "target"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const [input = "", to = ""] = positionals;
    const rel = typeof values.rel === "string" ? values.rel : "relates-to";
    const log = await openForCli(io, flags);
    const { actor, notes } = await resolveAttribution(log.git, { env: io.env });
    const doc = await linkDecision(
      log,
      { id: input, to, rel, actor },
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
