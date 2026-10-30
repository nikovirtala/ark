import { type JsonValue, resolveAttribution, type SetOp, UsageError } from "@nikovirtala/ledger";
import { COMMIT_HELP, COMMIT_OPTIONS, type CommandSpec } from "@nikovirtala/ledger/cli";
import { assignIssue, followScopeRenames, labelIssue, scopeIssue } from "../write.js";
import { runWrite } from "./lifecycle.js";
import { openForCli, strings } from "./open.js";
import { findingNotes, writeText } from "./text.js";

const NAMES = { set: "--set", add: "--add", remove: "--remove", clear: "--clear" } as const;
const SET_OPTIONS = {
  set: { type: "string", multiple: true },
  add: { type: "string", multiple: true },
  remove: { type: "string", multiple: true },
  clear: { type: "boolean" },
  ...COMMIT_OPTIONS,
} as const;

/** `CommandSpec.help` for `SET_OPTIONS`, with `what` as the value, such as `<label>`. */
const setHelp = (what: string, things: string) => ({
  set: { value: what, text: `replace the ${things} with these` },
  add: { value: what, text: `add to the ${things}` },
  remove: { value: what, text: `remove from the ${things}` },
  clear: { text: `remove all the ${things}` },
  ...COMMIT_HELP,
});

/** The set operation of `--set`, `--add`, `--remove` and `--clear`. */
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
  return {
    ...(set.length === 0 ? {} : { set }),
    ...(add.length === 0 ? {} : { add }),
    ...(remove.length === 0 ? {} : { remove }),
  };
}

const usage = (name: string, what: string) =>
  `${name} <issue> (--set <${what}>… | --add <${what}>… --remove <${what}>… | --clear) [--commit | --no-commit] [-m <message>]`;

/** `issues assign`: the assignees as a whole; `me` is you. */
export const assignCommand: CommandSpec = {
  name: "assign",
  summary: "set, add or remove an issue's assignees (me is you)",
  usage: usage("assign", "who"),
  options: SET_OPTIONS,
  help: setHelp("<who>", "assignees"),
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "assigned", (log, actor, o) =>
      assignIssue(log, { id: positionals[0] ?? "", op: setOp(values), actor, names: NAMES }, o),
    ),
};

/** `issues label`: the labels as a whole; an exclusive prefix holds one label. */
export const labelCommand: CommandSpec = {
  name: "label",
  summary: "set, add or remove an issue's labels",
  usage: usage("label", "label"),
  options: SET_OPTIONS,
  help: setHelp("<label>", "labels"),
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "labeled", (log, actor, o) =>
      labelIssue(log, { id: positionals[0] ?? "", op: setOp(values), actor, names: NAMES }, o),
    ),
};

/**
 * `--follow-renames` alone: no set operation, no commit and no message, all refused before the
 * commit choice so the answer doesn't depend on `auto_commit` (adr's rule).
 */
function checkFollowRenames(values: Readonly<Record<string, unknown>>): void {
  const op = ["set", "add", "remove"].some((k) => strings(values[k]).length > 0);
  if (op || values.clear === true) {
    throw new UsageError(
      "--follow-renames can't be combined with --set, --clear, --add or --remove",
    );
  }
  if (values.commit === true) {
    throw new UsageError(
      "--follow-renames stages its events for the commit that contains the renames; commit them together",
    );
  }
  if (typeof values.message === "string") {
    throw new UsageError("--follow-renames never commits, so it takes no --message");
  }
}

/**
 * `issues scope`: the code an issue concerns, as globs. `issues scope [<issue>]
 * --follow-renames` rewrites them after staged renames and stages the events, never committing.
 */
export const scopeCommand: CommandSpec = {
  name: "scope",
  summary: "set, add or remove the globs of the code an issue concerns",
  usage: `${usage("scope", "glob")} | scope [<issue>] --follow-renames`,
  options: { ...SET_OPTIONS, "follow-renames": { type: "boolean" } },
  help: {
    ...setHelp("<glob>", "scope globs"),
    "follow-renames": {
      text: "rewrite scope globs for staged renames (of every issue without <issue>)",
    },
  },
  positionals: { min: 0, max: 1, names: ["issue"] },
  ref: "reject",
  async run({ io, flags, values, positionals }) {
    const input = positionals[0];
    if (values["follow-renames"] === true) {
      checkFollowRenames(values);
      const log = await openForCli(io, flags);
      const { actor, notes } = await resolveAttribution(log.git, { env: io.env });
      const doc = await followScopeRenames(
        log,
        { ...(input === undefined ? {} : { id: input }), actor },
        { notes },
      );
      const text = doc.ok
        ? doc.affected.length === 0
          ? "no scope follows a staged rename\n"
          : `${doc.affected.map((v) => `${v.display}: ${v.applies_to.join(", ")}`).join("\n")}\n  staged ${doc.written.length} file${doc.written.length === 1 ? "" : "s"}\n`
        : writeText(doc, "scoped");
      return {
        exit: doc.ok ? 0 : 1,
        json: doc as unknown as JsonValue,
        text,
        notes: [...doc.notes, ...(doc.ok ? findingNotes(doc.findings) : [])],
      };
    }
    if (input === undefined) {
      throw new UsageError(`missing argument <issue>; usage: issues ${usage("scope", "glob")}`);
    }
    return runWrite(io, flags, values, "scoped", (log, actor, o) =>
      scopeIssue(log, { id: input, op: setOp(values), actor, names: NAMES }, o),
    );
  },
};
