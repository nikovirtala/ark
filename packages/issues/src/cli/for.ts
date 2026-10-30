import type { JsonValue } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { readIssues } from "../log.js";
import { issuesFor } from "../scope.js";
import { openForCli } from "./open.js";
import { forText } from "./text.js";

/** `issues for <path>… [--all]`: the open issues that concern each path. */
export const forCommand: CommandSpec = {
  name: "for",
  summary: "list the open issues for files, from scope globs and code anchors",
  usage: "for <path>… [--all]",
  options: { all: { type: "boolean" } },
  help: { all: { text: "include closed issues" } },
  positionals: { min: 1, max: 100, names: ["path"] },
  ref: "read",
  async run({ io, flags, values, positionals }) {
    const log = await openForCli(io, flags);
    const read = await readIssues(log);
    const doc = await issuesFor(read, log, {
      paths: positionals,
      cwd: io.cwd,
      all: values.all === true,
    });
    return {
      exit: 0,
      json: doc as unknown as JsonValue,
      text: forText(doc, read.issues.anchorKeyword),
      notes: doc.notes,
    };
  },
};
