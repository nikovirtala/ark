import { type JsonValue, resolveAttribution, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { editIssue } from "../write.js";
import { editorFor } from "./editor.js";
import { sections } from "./new.js";
import { openForCli, strings } from "./open.js";
import { findingNotes, writeText } from "./text.js";

/**
 * `issues edit <issue> [--title <title>] [--section <id>=<markdown>]…`: replaces the heading and
 * sections without an editor; without them, opens the description in `VISUAL` or `EDITOR`. Empty
 * text removes an optional section, and text adds it back in the template's order. A commit that
 * would leave the body failing template lint is refused, as with `new`.
 */
export const editCommand: CommandSpec = {
  name: "edit",
  summary: "edit an issue's description, in the editor or with --title and --section",
  usage:
    "edit <issue> [--title <title>] [--section <id>=<markdown>]… [--edit | --no-edit] [--commit | --no-commit] [-m <message>]",
  options: {
    title: { type: "string", value: "<title>", help: "the new title" },
    section: {
      type: "string",
      multiple: true,
      value: "<id>=<markdown>",
      help: "replace section <id> with <markdown>; empty text removes an optional section",
    },
    edit: {
      type: "boolean",
      help: "open the description in $VISUAL or $EDITOR (the default without --title and --section)",
      negatedHelp: "don't open an editor",
    },
    ...COMMIT_OPTIONS,
  },
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const given = sections(strings(values.section));
    const title = typeof values.title === "string" ? values.title : null;
    const direct = title !== null || Object.keys(given).length > 0;
    if (direct && values.edit === true) {
      throw new UsageError("--edit can't be combined with --title or --section");
    }
    if (!direct && values.edit === false) {
      throw new UsageError("nothing to edit: give --title or --section, or leave out --no-edit");
    }
    const log = await openForCli(io, flags);
    const { notes } = await resolveAttribution(log.git, { env: io.env });
    const editor = direct ? null : editorFor(io.env, { stdoutIsTTY: io.stdoutIsTTY });
    const doc = await editIssue(
      log,
      { id: positionals[0] ?? "", title, sections: given },
      {
        ...commitChoice(values, { autoCommit: log.issues.autoCommit }),
        notes,
        refuseIncomplete: true,
        ...(editor === null ? {} : { edit: editor }),
      },
    );
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: writeText(doc, "edited"),
      notes: [...doc.notes, ...(doc.ok ? findingNotes(doc.findings) : [])],
    };
  },
};
