import { exitCode, formatText, type JsonValue, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { type IndexRun, runDecisionIndex } from "../log-index.js";
import { openForCli } from "./open.js";

const short = (sha: string) => sha.slice(0, 7);

/** The text of `adr index` (design 2b §4.5). */
function indexText({ doc, refreshed }: IndexRun): string {
  const { path } = doc;
  if (doc.check)
    return doc.findings.length === 0 ? `${path} is up to date` : formatText(doc.findings);
  if (doc.commit !== null) {
    return [
      `Committed ${path} as ${short(doc.commit)}`,
      ...(refreshed ? [`Wrote ${path} with uncommitted log changes`] : []),
    ].join("\n");
  }
  if (refreshed) {
    return `${path} is up to date in HEAD; wrote the work tree's copy, which includes uncommitted log changes`;
  }
  if (doc.fresh) return `${path} is up to date`;
  return doc.written.length > 0 ? `Wrote ${path}` : `Staged ${path}`;
}

/** `adr index [--check] [--commit | --no-commit] [-m <message>]` (design 2b §4.5). */
export const indexCommand: CommandSpec = {
  name: "index",
  summary: "regenerate the decision index (index.md), or check that it is current",
  usage: "index [--check] [--commit | --no-commit] [-m <message>]",
  options: { check: { type: "boolean" }, ...COMMIT_OPTIONS },
  positionals: { min: 0, max: 0, names: [] },
  ref: "read",
  async run({ io, flags, values }) {
    const check = values.check === true;
    if (check && (values.commit === true || typeof values.message === "string")) {
      throw new UsageError("--check writes nothing; drop --commit and --message");
    }
    if (!check && flags.ref !== null) {
      throw new UsageError("adr index writes the work tree; use --ref only with --check");
    }
    const log = await openForCli(io, flags);
    const run = await runDecisionIndex(log, {
      check,
      ...(check ? {} : commitChoice(values, { autoCommit: log.adr.autoCommit })),
    });
    return {
      exit: check ? exitCode(run.doc.findings, { failOn: log.adr.failOn }) : 0,
      json: run.doc as unknown as JsonValue,
      text: indexText(run),
      notes: run.doc.notes,
    };
  },
};
