import type { JsonValue } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { readIssues, readSourceIssues } from "../log.js";
import { searchIssues } from "../search.js";
import { openForCli } from "./open.js";
import { searchText } from "./text.js";

/**
 * `issues search <query>… [--all] [--source <name>]`: words are joined, and every one must match.
 * `--source` searches a `[[sources]]` entry's cached issue log instead of the local one.
 */
export const searchCommand: CommandSpec = {
  name: "search",
  summary: "search issues' ids, titles, descriptions and comments",
  usage: "search <query>… [--all] [--source <name>]",
  options: { all: { type: "boolean" }, source: { type: "string" } },
  positionals: { min: 1, max: 20, names: ["query"] },
  ref: "read",
  async run({ io, flags, values, positionals }) {
    const log = await openForCli(io, flags);
    const read =
      typeof values.source === "string"
        ? await readSourceIssues(log, values.source)
        : await readIssues(log);
    const doc = searchIssues(read, {
      query: positionals.join(" "),
      includeClosed: values.all === true,
    });
    const notes = [...doc.notes];
    const k = doc.closed_omitted;
    if (k > 0) {
      notes.push(
        k === 1
          ? "1 closed issue also matches; add --all to see it"
          : `${k} closed issues also match; add --all to see them`,
      );
    }
    return { exit: 0, json: doc as unknown as JsonValue, text: searchText(doc), notes };
  },
};
