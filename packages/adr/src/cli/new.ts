import { type JsonValue, resolveAttribution, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { proposeDecision } from "../write.js";
import { editorFor } from "./editor.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { unfilledWarning, writeText } from "./text.js";

const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** `--section <id>=<markdown>` values, split at the first `=`; each id at most once. */
function sections(values: readonly string[]): Record<string, string> {
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
 * `adr new <title> …` (design §5.6). The editor runs with `--edit`, or without `--no-edit` when
 * the terminal is interactive and an editor is set.
 */
export const newCommand: CommandSpec = {
  name: "new",
  summary: "propose a decision from a template and stage it",
  usage:
    "new <title> [--template <name>] [--supersedes <decision>]… [--section <id>=<markdown>]… [--edit | --no-edit] [--commit | --no-commit] [-m <message>]",
  options: {
    template: { type: "string" },
    supersedes: { type: "string", multiple: true },
    section: { type: "string", multiple: true },
    edit: { type: "boolean" },
    ...COMMIT_OPTIONS,
  },
  positionals: { min: 1, max: 1, names: ["title"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const title = positionals[0] ?? "";
    const given = sections(strings(values.section));
    const log = await openForCli(io, flags);
    const { actor, notes: attribution } = await resolveAttribution(log.git, { env: io.env });
    // Design review NIT 1: the skip notes say "not committed" only when a commit was asked for.
    const { commit: requested, message } = commitChoice(values, {
      autoCommit: log.adr.autoCommit,
    });
    const notes: string[] = [];
    const editor = editorFor(io.env, { stdoutIsTTY: io.stdoutIsTTY });
    const wantsEdit = values.edit === true || (values.edit === undefined && io.interactive);
    if (values.edit === true && editor === null) notes.push("no editor: set VISUAL or EDITOR");
    const edit =
      wantsEdit && editor !== null
        ? async (abs: string) => {
            const note = await editor(abs);
            if (note !== null) notes.push(note);
            return note;
          }
        : undefined;
    const doc = await proposeDecision(
      log,
      {
        title,
        sections: given,
        supersedes: strings(values.supersedes),
        actor,
        ...(typeof values.template === "string" ? { template: values.template } : {}),
      },
      {
        commit: requested,
        message,
        notes: attribution,
        ...(edit === undefined ? {} : { edit }),
        onNote: (note) => notes.push(requested ? `not committed: ${note}` : note),
      },
    );
    const { display } = await displayAfterWrite(log);
    const v = doc.decision;
    const unfilled = unfilledWarning(doc);
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: writeText(doc, display, {
        subject: title.trim(),
        number: v === null || v.number === null ? null : v.display,
        actor,
        acceptRequiresHuman: log.adr.acceptRequiresHuman,
      }),
      notes: [...doc.notes, ...notes, ...(unfilled === null ? [] : [unfilled])],
    };
  },
};
