import type { JsonValue } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { issueCommits } from "../commits.js";
import { readIssues, resolveIssue } from "../log.js";
import { showIssue } from "../views.js";
import { openForCli } from "./open.js";
import { showText } from "./text.js";

/** `issues show <issue> [--history] [--commits] [--no-comments]`. */
export const showCommand: CommandSpec = {
  name: "show",
  summary: "show an issue: state, description, relations, comments and history",
  usage: "show <issue> [--history] [--commits] [--no-comments]",
  options: {
    history: { type: "boolean" },
    commits: { type: "boolean" },
    comments: { type: "boolean" },
  },
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "read",
  async run({ io, flags, values, positionals }) {
    const log = await openForCli(io, flags);
    const read = await readIssues(log);
    const id = resolveIssue(read, positionals[0] ?? "");
    const doc = showIssue(read, id, {
      history: values.history === true,
      comments: values.comments !== false,
      commits: values.commits === true ? await issueCommits(log, id) : null,
    });
    return { exit: 0, json: doc as unknown as JsonValue, text: showText(doc), notes: doc.notes };
  },
};
