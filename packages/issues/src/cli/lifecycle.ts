import { type Actor, type JsonValue, resolveAttribution } from "@nikovirtala/ledger";
import {
  type CliIO,
  COMMIT_OPTIONS,
  type CommandSpec,
  commitChoice,
  type GlobalFlags,
  type Outcome,
} from "@nikovirtala/ledger/cli";
import type { IssueLog } from "../log.js";
import {
  closeIssue,
  type IssueWriteJson,
  reopenIssue,
  startIssue,
  stopIssue,
  type WriteOptions,
} from "../write.js";
import { openForCli } from "./open.js";
import { findingNotes, writeText } from "./text.js";

/**
 * Runs one write: opens the log, resolves the actor (ADR-0007), and turns the document into an
 * outcome. Refusals exit 1; the write's warnings go to stderr as notes.
 */
export async function runWrite(
  io: CliIO,
  flags: GlobalFlags,
  values: Readonly<Record<string, unknown>>,
  verb: string,
  write: (log: IssueLog, actor: Actor, o: WriteOptions) => Promise<IssueWriteJson>,
): Promise<Outcome> {
  const log = await openForCli(io, flags);
  const { actor, notes } = await resolveAttribution(log.git, { env: io.env });
  const doc = await write(log, actor, {
    ...commitChoice(values, { autoCommit: log.issues.autoCommit }),
    notes,
  });
  return {
    exit: doc.ok ? 0 : 1,
    json: doc as unknown as JsonValue,
    text: writeText(doc, verb),
    notes: [...doc.notes, ...(doc.ok ? findingNotes(doc.findings) : [])],
  };
}

const reason = (values: Readonly<Record<string, unknown>>) =>
  typeof values.reason === "string" ? values.reason : null;

/** `issues start <issue>`: work begins; assigns you when nobody is. */
export const startCommand: CommandSpec = {
  name: "start",
  summary: "start work on an issue (assigns you when unassigned)",
  usage: "start <issue> [--commit | --no-commit] [-m <message>]",
  options: { ...COMMIT_OPTIONS },
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "started", (log, actor, o) =>
      startIssue(log, { id: positionals[0] ?? "", actor }, o),
    ),
};

/** `issues stop <issue>`: work pauses without finishing; back to open. */
export const stopCommand: CommandSpec = {
  name: "stop",
  summary: "stop work on an issue without finishing it",
  usage: "stop <issue> [--reason <text>] [--commit | --no-commit] [-m <message>]",
  options: { reason: { type: "string" }, ...COMMIT_OPTIONS },
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "stopped", (log, actor, o) =>
      stopIssue(log, { id: positionals[0] ?? "", reason: reason(values), actor }, o),
    ),
};

/** `issues close <issue>`: done by default; a reason unless done; `--duplicate-of` for duplicates. */
export const closeCommand: CommandSpec = {
  name: "close",
  summary: "close an issue as done, won't fix, obsolete or a duplicate",
  usage:
    "close <issue> [--resolution done|wontfix|duplicate|obsolete] [--duplicate-of <issue>] [--reason <text>] [--commit | --no-commit] [-m <message>]",
  options: {
    resolution: { type: "string" },
    "duplicate-of": { type: "string" },
    reason: { type: "string" },
    ...COMMIT_OPTIONS,
  },
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "closed", (log, actor, o) =>
      closeIssue(
        log,
        {
          id: positionals[0] ?? "",
          resolution: typeof values.resolution === "string" ? values.resolution : null,
          of: typeof values["duplicate-of"] === "string" ? values["duplicate-of"] : null,
          reason: reason(values),
          actor,
        },
        o,
      ),
    ),
};

/** `issues reopen <issue> --reason <text>`. */
export const reopenCommand: CommandSpec = {
  name: "reopen",
  summary: "reopen a closed issue",
  usage: "reopen <issue> --reason <text> [--commit | --no-commit] [-m <message>]",
  options: { reason: { type: "string" }, ...COMMIT_OPTIONS },
  positionals: { min: 1, max: 1, names: ["issue"] },
  ref: "reject",
  run: ({ io, flags, values, positionals }) =>
    runWrite(io, flags, values, "reopened", (log, actor, o) =>
      reopenIssue(log, { id: positionals[0] ?? "", reason: reason(values), actor }, o),
    ),
};
