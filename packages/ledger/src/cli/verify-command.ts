import { type JsonValue, UsageError } from "../errors.js";
import { exitCode, type Severity } from "../findings/finding.js";
import { findingsReport, formatGithub, formatJson, formatText } from "../findings/format.js";
import type { Git } from "../git/git.js";
import type { LogLayout } from "../identity/layout.js";
import type { AnyKind } from "../kind/types.js";
import type { SourceStatus } from "../sources/read.js";
import type { Check } from "../verify/checks.js";
import { touchedInputs, type VerifyMode, verifyLog } from "../verify/verify.js";
import type { GlobalFlags } from "./flags.js";
import type { CliIO } from "./output.js";
import type { CommandSpec } from "./run.js";

export interface VerifyCommandOptions {
  /**
   * Opens the log for verify; called with the parsed globals and the mode `verifyCommand` derived
   * from the flags, so the tool can compute `templateHistoryRef(git, mode)` for its checks.
   * `fetchSources` is `--fetch-sources`: read the `[[sources]]` from the network (`readSources`
   * `"network"`, a failed fetch throws `SourceFetchError`, exit 2), else from the cache only.
   */
  open(ctx: {
    readonly io: CliIO;
    readonly flags: GlobalFlags;
    readonly mode: VerifyMode;
    readonly fetchSources: boolean;
  }): Promise<{
    readonly git: Git;
    readonly kind: AnyKind;
    readonly layout: LogLayout;
    readonly checks: readonly Check[];
    readonly failOn: Severity;
    /** `ToolLog.notes`; `verifyCommand` copies them into `Outcome.notes` (stderr only). */
    readonly notes?: readonly string[];
    /** Inputs outside the log whose staged change widens `--staged` to every subject. */
    readonly widenOn?: readonly string[];
    /** The sources the tool read, for the report's `sources` field; omit without `[[sources]]`. */
    readonly sources?: readonly SourceStatus[];
  }>;
}

const FORMATS = ["text", "json", "github"] as const;
type Format = (typeof FORMATS)[number];

function isFormat(v: unknown): v is Format {
  return typeof v === "string" && (FORMATS as readonly string[]).includes(v);
}

/** The forms of an upstream spec git accepts: `@{upstream}`, `@{u}`, `<branch>@{u}`, any case. */
const UPSTREAM = /^[^@]*@\{(?:upstream|u)\}$/i;
const ORIGIN_DEFAULTS = ["refs/remotes/origin/main", "refs/remotes/origin/master"];

/**
 * The fallback for a branch with no upstream (00's pre-push rule). It acts only on a `range` mode
 * whose base is an upstream spec that doesn't resolve: the base becomes the first of
 * `origin/HEAD`'s target, `origin/main` and `origin/master` that resolves, and with none the mode
 * becomes `full` (keeping `head`), so a repository with no remote verifies the whole log. Any
 * other mode or base is returned as it is, so an unresolvable base still fails in `verifyLog`.
 * `note` says what was done, or is `null`.
 */
export async function resolveVerifyBase(
  git: Git,
  mode: VerifyMode,
): Promise<{ readonly mode: VerifyMode; readonly note: string | null }> {
  if (mode.type !== "range" || !UPSTREAM.test(mode.base)) return { mode, note: null };
  if ((await git.resolveCommit(mode.base)) !== null) return { mode, note: null };
  const originHead = await git.symbolicRef("refs/remotes/origin/HEAD");
  for (const ref of [...(originHead === null ? [] : [originHead]), ...ORIGIN_DEFAULTS]) {
    if ((await git.resolveCommit(ref)) === null) continue;
    const short = ref.replace(/^refs\/remotes\//, "");
    return {
      mode: { ...mode, base: ref },
      note: `no upstream for this branch; verifying against ${short}`,
    };
  }
  const remotes = Buffer.from((await git.run(["remote"])).stdout)
    .toString()
    .trim();
  return {
    mode: { type: "full", ...(mode.head === undefined ? {} : { head: mode.head }) },
    note:
      remotes === ""
        ? "no upstream and no remote; verifying the whole log"
        : "no upstream, and origin has no default branch here; verifying the whole log",
  };
}

/** The note for a widened `--staged` run. */
function widenedNote(kind: string, touched: readonly string[]): string {
  const more = touched.length > 1 ? ` and ${touched.length - 1} more` : "";
  return `--staged checks every ${kind}: the staged changes touch ${touched[0]}${more}`;
}

/** The stderr note for a source a verify run read. */
function sourceNote(s: SourceStatus): string | null {
  if (s.commit === null) return null;
  const how = s.fetched ? "fetched now" : "from the cache";
  return `source ${s.name} (${s.ref}) at ${s.commit.slice(0, 12)}, ${how}`;
}

/**
 * The shared `verify [--staged | --base <ref>] [--fetch-sources] [--format text|json|github]`
 * command. `--ref` sets
 * the head: the mode is `staged`, `range { base, head: ref }` or `full { head: ref }`. With
 * `--json` (or `--format json`) it prints the `ledger-findings/v1` report; it exits 1 when the
 * findings fail at the tool's `failOn`. A `--base @{upstream}` with no upstream falls back as
 * `resolveVerifyBase` says, with a note on stderr. `--fetch-sources` fetches the tool's sources
 * before any check runs; the report's `sources` field records what each resolved to.
 */
export function verifyCommand(o: VerifyCommandOptions): CommandSpec {
  return {
    name: "verify",
    summary: "check the log against its rules",
    usage: "verify [--staged | --base <ref>] [--fetch-sources] [--format text|json|github]",
    options: {
      staged: { type: "boolean", help: "check the staged changes, as the pre-commit hook does" },
      base: { type: "string", value: "<ref>", help: "check what changed since <ref>" },
      "fetch-sources": { type: "boolean", help: "fetch [[sources]] before checking" },
      format: {
        type: "string",
        value: "<format>",
        help: "the report: text, json or github (default: text)",
      },
    },
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

      const fetchSources = values["fetch-sources"] === true;
      const log = await o.open({ io, flags, mode, fetchSources });
      const resolved = await resolveVerifyBase(log.git, mode);
      const widenOn = log.widenOn ?? [];
      const findings = await verifyLog({
        git: log.git,
        kind: log.kind,
        layout: log.layout,
        mode: resolved.mode,
        checks: log.checks,
        widenOn,
      });
      const touched = await touchedInputs(log.git, resolved.mode, widenOn);
      const notes = [
        ...(log.notes ?? []),
        ...(resolved.note === null ? [] : [resolved.note]),
        ...(touched.length === 0 ? [] : [widenedNote(log.kind.def.name, touched)]),
        ...(format === "json"
          ? []
          : (log.sources ?? []).flatMap((s) => {
              const n = sourceNote(s);
              return n === null ? [] : [n];
            })),
      ];
      const failOn = {
        failOn: log.failOn,
        ...(log.sources === undefined ? {} : { sources: log.sources }),
      };
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
        ...(notes.length === 0 ? {} : { notes }),
      };
    },
  };
}
