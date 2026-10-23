import {
  exitCode,
  type Finding,
  type FindingsSummary,
  type Severity,
  sortFindings,
  summarize,
} from "./finding.js";

/** The `--json` report. Every key is always present so consumers can rely on the shape. */
export interface FindingsReport {
  readonly format: "ledger-findings/v1";
  readonly ok: boolean;
  readonly summary: FindingsSummary;
  readonly findings: readonly Finding[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * One line per finding, `<file>[:<line>]: <severity>: <message> [<rule>]( (<subject>))`, then a
 * blank line and the summary. `No findings.` when there are none.
 */
export function formatText(fs: readonly Finding[]): string {
  if (fs.length === 0) return "No findings.";
  const lines = sortFindings(fs).map((f) => {
    const location = f.file === null ? "" : `${f.file}${f.line === null ? "" : `:${f.line}`}: `;
    const subject = f.subject === null ? "" : ` (${f.subject})`;
    return `${location}${f.severity}: ${f.message} [${f.rule}]${subject}`;
  });
  const { errors, warnings } = summarize(fs);
  return `${lines.join("\n")}\n\n${plural(errors, "error")}, ${plural(warnings, "warning")}`;
}

/**
 * The `ledger-findings/v1` report as an object, findings sorted and with every key, for tools that
 * embed it in a larger JSON document.
 */
export function findingsReport(
  fs: readonly Finding[],
  opts: { readonly failOn?: Severity } = {},
): FindingsReport {
  return {
    format: "ledger-findings/v1",
    ok: exitCode(fs, opts) === 0,
    summary: summarize(fs),
    findings: sortFindings(fs).map((f) => ({
      severity: f.severity,
      rule: f.rule,
      message: f.message,
      file: f.file,
      line: f.line,
      subject: f.subject,
      kind: f.kind,
    })),
  };
}

/** The `ledger-findings/v1` report, 2-space indented, ending with a newline. */
export function formatJson(
  fs: readonly Finding[],
  opts: { readonly failOn?: Severity } = {},
): string {
  return `${JSON.stringify(findingsReport(fs, opts), null, 2)}\n`;
}

function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** GitHub Actions workflow commands, one `::error …::` or `::warning …::` line per finding. */
export function formatGithub(fs: readonly Finding[]): string {
  return sortFindings(fs)
    .map((f) => {
      const props: string[] = [];
      if (f.file !== null) props.push(`file=${escapeProperty(f.file)}`);
      if (f.line !== null) props.push(`line=${f.line}`);
      props.push(`title=${escapeProperty(f.rule)}`);
      const subject = f.subject === null ? "" : ` (${f.subject})`;
      return `::${f.severity} ${props.join(",")}::${escapeData(f.message + subject)}`;
    })
    .join("\n");
}
