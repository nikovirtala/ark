import { type JsonValue, UsageError } from "../errors.js";
import { exitCode, type Severity } from "../findings/finding.js";
import { findingsReport, formatGithub, formatJson, formatText } from "../findings/format.js";
import type { Git } from "../git/git.js";
import type { LogLayout } from "../identity/layout.js";
import type { AnyKind } from "../kind/types.js";
import type { Check } from "../verify/checks.js";
import { type VerifyMode, verifyLog } from "../verify/verify.js";
import type { GlobalFlags } from "./flags.js";
import type { CliIO } from "./output.js";
import type { CommandSpec } from "./run.js";

export interface VerifyCommandOptions {
  /**
   * Opens the log for verify; called with the parsed globals and the mode `verifyCommand` derived
   * from the flags, so the tool can compute `templateHistoryRef(git, mode)` for its checks.
   */
  open(ctx: {
    readonly io: CliIO;
    readonly flags: GlobalFlags;
    readonly mode: VerifyMode;
  }): Promise<{
    readonly git: Git;
    readonly kind: AnyKind;
    readonly layout: LogLayout;
    readonly checks: readonly Check[];
    readonly failOn: Severity;
    /** `ToolLog.notes`; `verifyCommand` copies them into `Outcome.notes` (stderr only). */
    readonly notes?: readonly string[];
  }>;
}

const FORMATS = ["text", "json", "github"] as const;
type Format = (typeof FORMATS)[number];

function isFormat(v: unknown): v is Format {
  return typeof v === "string" && (FORMATS as readonly string[]).includes(v);
}

/**
 * The shared `verify [--staged | --base <ref>] [--format text|json|github]` command. `--ref` sets
 * the head: the mode is `staged`, `range { base, head: ref }` or `full { head: ref }`. With
 * `--json` (or `--format json`) it prints the `ledger-findings/v1` report; it exits 1 when the
 * findings fail at the tool's `failOn`.
 */
export function verifyCommand(o: VerifyCommandOptions): CommandSpec {
  return {
    name: "verify",
    summary: "check the log against its rules",
    usage: "verify [--staged | --base <ref>] [--format text|json|github]",
    options: { staged: { type: "boolean" }, base: { type: "string" }, format: { type: "string" } },
    positionals: { min: 0, max: 0, names: [] },
    ref: "read",
    async run({ io, flags, values }) {
      const staged = values.staged === true;
      const base = typeof values.base === "string" ? values.base : null;
      if (values.format !== undefined && !isFormat(values.format)) {
        throw new UsageError(`--format must be text, json or github`);
      }
      if (flags.json && values.format !== undefined && values.format !== "json") {
        throw new UsageError(`--json can't be combined with --format ${values.format}`);
      }
      if (staged && (base !== null || flags.ref !== null)) {
        throw new UsageError("--staged can't be combined with --base or --ref");
      }
      if (base !== null && base.trim() === "") throw new UsageError("--base must not be empty");
      const format: Format = flags.json ? "json" : (values.format ?? "text");
      const head = flags.ref === null ? {} : { head: flags.ref };
      const mode: VerifyMode = staged
        ? { type: "staged" }
        : base !== null
          ? { type: "range", base, ...head }
          : { type: "full", ...head };

      const log = await o.open({ io, flags, mode });
      const findings = await verifyLog({
        git: log.git,
        kind: log.kind,
        layout: log.layout,
        mode,
        checks: log.checks,
      });
      const failOn = { failOn: log.failOn };
      const text =
        format === "json"
          ? formatJson(findings, failOn)
          : format === "github"
            ? formatGithub(findings)
            : formatText(findings);
      return {
        exit: exitCode(findings, failOn),
        // Plain JSON data; the interface just has no index signature.
        json: findingsReport(findings, failOn) as unknown as JsonValue,
        text,
        ...(log.notes === undefined ? {} : { notes: log.notes }),
      };
    },
  };
}
