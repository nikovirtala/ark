import { type JsonValue, resolveAttribution, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { openIssue } from "../write.js";
import { editorFor } from "./editor.js";
import { openForCli, strings } from "./open.js";
import { findingNotes, writeText } from "./text.js";

/** `--section <id>=<markdown>` values, split at the first `=`; each id at most once. */
export function sections(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    const id = at < 0 ? "" : value.slice(0, at).trim();
    if (id === "") {
      throw new UsageError(`--section needs <id>=<markdown>, not ${JSON.stringify(value)}`);
    }
    if (Object.hasOwn(out, id)) throw new UsageError(`--section ${id} is given twice`);
    out[id] = value.slice(at + 1);
  }
  return out;
}

/**
 * `issues new <title> …`. The editor runs with `--edit`, or without `--no-edit` when the terminal
 * is interactive and an editor is set. A draft with unfilled required sections is never
 * committed.
 */
export const newCommand: CommandSpec = {
  name: "new",
  summary: "open an issue from a template and stage it",
  usage:
    "new <title> [--template <name>] [--parent <issue>] [--depends-on <issue>]… [--label <label>]… [--section <id>=<markdown>]… [--edit | --no-edit] [--commit | --no-commit] [-m <message>]",
  options: {
    template: {
      type: "string",
      value: "<name>",
      help: "the template to open the issue from (default: [log] default_template)",
    },
    parent: { type: "string", value: "<issue>", help: "the parent issue (a part-of link)" },
    "depends-on": {
      type: "string",
      multiple: true,
      value: "<issue>",
      help: "an issue this one depends on",
    },
    label: { type: "string", multiple: true, value: "<label>", help: "a label to add" },
    section: {
      type: "string",
      multiple: true,
      value: "<id>=<markdown>",
      help: "fill section <id> with <markdown>",
    },
    edit: {
      type: "boolean",
      help: "open the draft in $VISUAL or $EDITOR (default: when one is set and the terminal is interactive)",
      negatedHelp: "don't open an editor",
    },
    ...COMMIT_OPTIONS,
  },
  positionals: { min: 1, max: 1, names: ["title"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const title = positionals[0] ?? "";
    const given = sections(strings(values.section));
    const log = await openForCli(io, flags);
    const { actor, notes: attribution } = await resolveAttribution(log.git, { env: io.env });
    const { commit: requested, message } = commitChoice(values, {
      autoCommit: log.issues.autoCommit,
    });
    const notes: string[] = [];
    const editor = editorFor(io.env, { stdoutIsTTY: io.stdoutIsTTY });
    const wantsEdit = values.edit === true || (values.edit === undefined && io.interactive);
    if (values.edit === true && editor === null) notes.push("no editor: set VISUAL or EDITOR");
    const doc = await openIssue(
      log,
      {
        title,
        sections: given,
        parent: typeof values.parent === "string" ? values.parent : null,
        dependsOn: strings(values["depends-on"]),
        labels: strings(values.label),
        actor,
        ...(typeof values.template === "string" ? { template: values.template } : {}),
      },
      {
        commit: requested,
        message,
        notes: attribution,
        ...(wantsEdit && editor !== null ? { edit: editor } : {}),
        onNote: (note) => notes.push(requested ? `not committed: ${note}` : note),
      },
    );
    const own = new Set(notes);
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: writeText(doc, "opened"),
      notes: [
        ...doc.notes.filter((n) => !own.has(n) && !own.has(`not committed: ${n}`)),
        ...notes,
        ...(doc.ok ? findingNotes(doc.findings) : []),
      ],
    };
  },
};
