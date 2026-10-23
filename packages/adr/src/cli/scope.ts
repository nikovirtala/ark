import { type JsonValue, resolveAttribution, type SetOp, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { readDecisions, resolveDecision } from "../log.js";
import { scopeDecision } from "../write.js";
import { displayAfterWrite, openForCli } from "./open.js";
import { writeText } from "./text.js";

const USAGE =
  "scope <decision> ([--set <glob>]… | --clear | [--add <glob>]… [--remove <glob>]…) [--commit | --no-commit] [-m <message>]";
/** The flag names `applySetOp` uses in its messages (design §3.2). */
const NAMES = { set: "--set", add: "--add", remove: "--remove", clear: "--clear" } as const;

const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** `--set`/`--clear`/`--add`/`--remove` as a set operation; `--clear` is `{ set: [] }`. */
function setOp(values: Readonly<Record<string, unknown>>): SetOp {
  const set = strings(values.set);
  const add = strings(values.add);
  const remove = strings(values.remove);
  if (values.clear === true) {
    if (set.length > 0 || add.length > 0 || remove.length > 0) {
      throw new UsageError("--clear can't be combined with --set, --add or --remove");
    }
    return { set: [] };
  }
  return { ...(set.length > 0 ? { set } : {}), add, remove };
}

/**
 * `adr scope <decision> --set|--clear|--add|--remove …` (design §6.8): the globs of the code a
 * decision governs, written as one whole-set `scoped` event.
 */
export const scopeCommand: CommandSpec = {
  name: "scope",
  summary: "set, add or remove the globs of the code a decision governs",
  usage: USAGE,
  options: {
    set: { type: "string", multiple: true },
    add: { type: "string", multiple: true },
    remove: { type: "string", multiple: true },
    clear: { type: "boolean" },
    ...COMMIT_OPTIONS,
  },
  positionals: { min: 0, max: 1, names: ["decision"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const input = positionals[0];
    const op = setOp(values);
    if (input === undefined)
      throw new UsageError(`missing argument <decision>; usage: adr ${USAGE}`);
    const log = await openForCli(io, flags);
    const { actor, notes } = await resolveAttribution(log.git, { env: io.env });
    const choice = commitChoice(values, { autoCommit: log.adr.autoCommit });
    const read = await readDecisions(log);
    const before = read.projection.views.get(resolveDecision(read, input))?.applies_to ?? [];
    const doc = await scopeDecision(
      log,
      { id: input, op, actor, names: NAMES },
      { ...choice, notes },
    );
    const { display } = await displayAfterWrite(log);
    const v = doc.decision;
    return {
      exit: doc.ok ? 0 : 1,
      json: doc as unknown as JsonValue,
      text: writeText(doc, display, {
        subject: v === null ? input.trim() : `${display(v.id)}: ${v.title}`,
        number: null,
        scopeBefore: before,
      }),
      notes: doc.notes,
    };
  },
};
