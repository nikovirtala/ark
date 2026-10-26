import { COMMIT_OPTIONS, type CommandSpec } from "@nikovirtala/ledger/cli";
import { commentIssue } from "../write.js";
import { runWrite } from "./lifecycle.js";

/** `issues comment <issue> <text>`: discussion and progress notes, in any state. */
export const commentCommand: CommandSpec = {
  name: "comment",
  summary: "add a comment to an issue",
  usage: "comment <issue> <text> [--commit | --no-commit] [-m <message>]",
  options: { ...COMMIT_OPTIONS },
  positionals: { min: 2, max: 2, names: ["issue", "text"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "commented on", (log, actor, o) =>
      commentIssue(log, { id: positionals[0] ?? "", text: positionals[1] ?? "", actor }, o),
    ),
};
