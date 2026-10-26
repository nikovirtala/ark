import { COMMIT_OPTIONS, type CommandSpec } from "@nikovirtala/ledger/cli";
import { linkIssue, unlinkIssue } from "../write.js";
import { runWrite } from "./lifecycle.js";

const rel = (values: Readonly<Record<string, unknown>>) =>
  typeof values.rel === "string" ? values.rel : null;

/** `issues link <issue> <target> [--rel …]`: a relation, stored on the source issue. */
export const linkCommand: CommandSpec = {
  name: "link",
  summary: "link an issue to another issue, or to a decision with --rel implements",
  usage:
    "link <issue> <target> [--rel depends-on|part-of|relates-to|implements] [--commit | --no-commit] [-m <message>]",
  options: { rel: { type: "string" }, ...COMMIT_OPTIONS },
  positionals: { min: 2, max: 2, names: ["issue", "target"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "linked", (log, actor, o) =>
      linkIssue(
        log,
        { id: positionals[0] ?? "", to: positionals[1] ?? "", rel: rel(values), actor },
        o,
      ),
    ),
};

/** `issues unlink <issue> <target> [--rel …]`: removes a relation; the stored target always works. */
export const unlinkCommand: CommandSpec = {
  name: "unlink",
  summary: "remove a relation of an issue",
  usage:
    "unlink <issue> <target> [--rel depends-on|part-of|relates-to|implements] [--commit | --no-commit] [-m <message>]",
  options: { rel: { type: "string" }, ...COMMIT_OPTIONS },
  positionals: { min: 2, max: 2, names: ["issue", "target"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "unlinked", (log, actor, o) =>
      unlinkIssue(
        log,
        { id: positionals[0] ?? "", to: positionals[1] ?? "", rel: rel(values), actor },
        o,
      ),
    ),
};
