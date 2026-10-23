import { type JsonValue, resolveActor } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { acceptDecision } from "../write.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { writeText } from "./text.js";

/** `adr accept <decision> [--commit | --no-commit] [-m <message>]` (design §5.6). */
export const acceptCommand: CommandSpec = {
  name: "accept",
  summary: "accept a proposed decision, superseding the decisions it declares",
  usage: "accept <decision> [--commit | --no-commit] [-m <message>]",
  options: { ...COMMIT_OPTIONS },
  positionals: { min: 1, max: 1, names: ["decision"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const input = positionals[0] ?? "";
    const log = await openForCli(io, flags);
    const actor = await resolveActor(log.git, { env: io.env });
    const doc = await acceptDecision(
      log,
      { id: input, actor },
      commitChoice(values, { autoCommit: log.adr.autoCommit }),
    );
    const { display } = await displayAfterWrite(log);
    const v = doc.decision;
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: writeText(doc, display, {
        subject: v === null ? input.trim() : `${display(v.id)}: ${v.title}`,
        number: v === null || doc.commit === null || v.number === null ? null : v.display,
      }),
      notes: doc.notes,
    };
  },
};
