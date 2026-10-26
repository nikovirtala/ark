import { type SetOp, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec } from "@nikovirtala/ledger/cli";
import { assignIssue, labelIssue, scopeIssue } from "../write.js";
import { runWrite } from "./lifecycle.js";
import { strings } from "./open.js";

const NAMES = { set: "--set", add: "--add", remove: "--remove", clear: "--clear" } as const;
const SET_OPTIONS = {
  set: { type: "string", multiple: true },
  add: { type: "string", multiple: true },
  remove: { type: "string", multiple: true },
  clear: { type: "boolean" },
  ...COMMIT_OPTIONS,
} as const;

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
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "labeled", (log, actor, o) =>
      labelIssue(log, { id: positionals[0] ?? "", op: setOp(values), actor, names: NAMES }, o),
    ),
};

/** `issues scope`: the code an issue concerns, as globs. */
export const scopeCommand: CommandSpec = {
  name: "scope",
  summary: "set, add or remove the globs of the code an issue concerns",
  usage: usage("scope", "glob"),
  options: SET_OPTIONS,
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "scoped", (log, actor, o) =>
      scopeIssue(log, { id: positionals[0] ?? "", op: setOp(values), actor, names: NAMES }, o),
    ),
};
