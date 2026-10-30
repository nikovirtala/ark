import { type JsonValue, UsageError } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { clearCurrentIssue, setCurrentIssue, showCurrentIssue } from "../work.js";
import { openForCli } from "./open.js";
import { workText } from "./text.js";

/** `issues work [<issue>] [--clear]`: the issue you are working on in this worktree. */
export const workCommand: CommandSpec = {
  name: "work",
  summary: "set, show or clear your current issue in this worktree",
  usage: "work [<issue>] [--clear]",
  options: { clear: { type: "boolean", help: "clear your current issue" } },
  positionals: { min: 0, max: 1, names: ["issue"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const input = positionals[0];
    if (input !== undefined && values.clear === true) {
      throw new UsageError("--clear can't be combined with an issue");
    }
    const log = await openForCli(io, flags);
    const doc =
      values.clear === true
        ? await clearCurrentIssue(log)
        : input === undefined
          ? await showCurrentIssue(log)
          : await setCurrentIssue(log, input);
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: workText(doc),
      notes: doc.notes,
    };
  },
};
