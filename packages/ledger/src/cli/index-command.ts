import { type JsonValue, UsageError } from "../errors.js";
import { exitCode, type Severity } from "../findings/finding.js";
import { formatText } from "../findings/format.js";
import type { IndexRun, ToolWriteOptions } from "../surfaces/tool-index.js";
import { COMMIT_OPTIONS, commitChoice } from "./commit.js";
import type { GlobalFlags } from "./flags.js";
import type { CliIO } from "./output.js";
import type { CommandSpec } from "./run.js";

export interface IndexCommandOptions {
  /** The tool's name, for the usage errors. */
  readonly tool: string;
  /** What the log's subjects are called, such as `"decision"`, for the summary. */
  readonly noun: string;
  /** `--check`'s help line; without it `--help` lists the option without one. */
  readonly checkHelp?: string;
  /**
   * Opens the tool's log: `run` is its `runLogIndex` call, `autoCommit` and `failOn` its
   * `[policy] auto_commit` and `[policy] fail_on`.
   */
  open(ctx: { readonly io: CliIO; readonly flags: GlobalFlags }): Promise<{
    readonly autoCommit: boolean;
    readonly failOn: Severity;
    run(o: ToolWriteOptions & { readonly check?: boolean }): Promise<IndexRun>;
  }>;
}

const short = (sha: string) => sha.slice(0, 7);

/** The text of `<tool> index` (design 2b §4.5). */
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

/**
 * The shared `index [--check] [--commit | --no-commit] [-m <message>]` command (design 2b §4.5):
 * regenerates `<root>/index.md` through the tool's `runLogIndex`, or with `--check` reports its
 * `index/*` findings and exits by `[policy] fail_on`.
 */
export function indexCommand(o: IndexCommandOptions): CommandSpec {
  return {
    name: "index",
    summary: `regenerate the ${o.noun} index (index.md), or check that it is current`,
    usage: "index [--check] [--commit | --no-commit] [-m <message>]",
    options: {
      check: { type: "boolean", ...(o.checkHelp === undefined ? {} : { help: o.checkHelp }) },
      ...COMMIT_OPTIONS,
    },
    positionals: { min: 0, max: 0, names: [] },
    ref: "read",
    async run({ io, flags, values }) {
      const check = values.check === true;
      if (check && (values.commit === true || typeof values.message === "string")) {
        throw new UsageError("--check writes nothing; drop --commit and --message");
      }
      if (!check && flags.ref !== null) {
        throw new UsageError(`${o.tool} index writes the work tree; use --ref only with --check`);
      }
      const log = await o.open({ io, flags });
      const run = await log.run({
        check,
        ...(check ? {} : commitChoice(values, { autoCommit: log.autoCommit })),
      });
      return {
        exit: check ? exitCode(run.doc.findings, { failOn: log.failOn }) : 0,
        json: run.doc as unknown as JsonValue,
        text: indexText(run),
        notes: run.doc.notes,
      };
    },
  };
}
