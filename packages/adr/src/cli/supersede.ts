import { type JsonValue, resolveActor, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { supersedeDecision } from "../write.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { writeText } from "./text.js";

const USAGE =
  "supersede <decision> --by <decision> [--reason <text>] [--commit | --no-commit] [-m <message>]";

/** `adr supersede <decision> --by <decision> …` (design §5.6). */
export const supersedeCommand: CommandSpec = {
  name: "supersede",
  summary: "mark an accepted decision as superseded by another accepted one",
  usage: USAGE,
  options: { by: { type: "string" }, reason: { type: "string" }, ...COMMIT_OPTIONS },
  positionals: { min: 1, max: 1, names: ["decision"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const input = positionals[0] ?? "";
    if (typeof values.by !== "string") {
      throw new UsageError(`missing --by <decision>; usage: adr ${USAGE}`);
    }
    const log = await openForCli(io, flags);
    const actor = await resolveActor(log.git, { env: io.env });
    const doc = await supersedeDecision(
      log,
      {
        id: input,
        by: values.by,
        actor,
        ...(typeof values.reason === "string" ? { reason: values.reason } : {}),
      },
      commitChoice(values, { autoCommit: log.adr.autoCommit }),
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
