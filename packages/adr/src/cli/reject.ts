import { type JsonValue, resolveAttribution, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { rejectDecision } from "../write.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { writeText } from "./text.js";

const USAGE = "reject <decision> --reason <text> [--commit | --no-commit] [-m <message>]";

/** `adr reject` (design §6.3): a proposal that won't be adopted. */
export const rejectCommand: CommandSpec = {
  name: "reject",
  summary: "reject a proposed decision",
  usage: USAGE,
  options: { reason: { type: "string" }, ...COMMIT_OPTIONS },
  positionals: { min: 1, max: 1, names: ["decision"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const input = positionals[0] ?? "";
    if (typeof values.reason !== "string" || values.reason.trim() === "") {
      throw new UsageError(`missing --reason <text>; usage: adr ${USAGE}`);
    }
    const reason = typeof values.reason === "string" ? values.reason.trim() : null;
    const log = await openForCli(io, flags);
    const { actor, notes } = await resolveAttribution(log.git, { env: io.env });
    const doc = await rejectDecision(
      log,
      { id: input, reason, actor },
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
        reason,
      }),
      notes: doc.notes,
    };
  },
};
