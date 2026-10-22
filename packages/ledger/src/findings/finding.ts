export type Severity = "error" | "warning";

/** One problem found in repository data. Wrong data is reported, never thrown. */
export interface Finding {
  readonly severity: Severity;
  /** Stable id, `<area>/<name>`, for example `append-only/modified`. */
  readonly rule: string;
  /** One line, no trailing period. */
  readonly message: string;
  /** Repo-relative POSIX path. */
  readonly file: string | null;
  /** 1-based, when known. */
  readonly line: number | null;
  /** Canonical or qualified subject id. */
  readonly subject: string | null;
  /** Envelope kind of the log being verified. */
  readonly kind: string | null;
}

export interface FindingsSummary {
  readonly errors: number;
  readonly warnings: number;
}

/** Builds a finding with every key present, replacing any newline in `message` with a space. */
export function finding(
  init: Omit<Finding, "line" | "subject" | "kind" | "file"> & Partial<Finding>,
): Finding {
  return {
    severity: init.severity,
    rule: init.rule,
    message: init.message.replace(/\r\n|\r|\n/g, " "),
    file: init.file ?? null,
    line: init.line ?? null,
    subject: init.subject ?? null,
    kind: init.kind ?? null,
  };
}

function compareNullable<T extends string | number>(a: T | null, b: T | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    compareNullable(a.file, b.file) ||
    compareNullable(a.line, b.line) ||
    compareNullable(a.severity === "error" ? 0 : 1, b.severity === "error" ? 0 : 1) ||
    compareNullable(a.rule, b.rule) ||
    compareNullable(a.subject, b.subject) ||
    compareNullable(a.message, b.message) ||
    compareNullable(a.kind, b.kind)
  );
}

/**
 * Sorts by file (nulls first), line, severity (errors first), rule, subject and message, with
 * `kind` as the final tie-breaker so the order never depends on the input order.
 */
export function sortFindings(fs: readonly Finding[]): Finding[] {
  return [...fs].sort(compareFindings);
}

export function summarize(fs: readonly Finding[]): FindingsSummary {
  let errors = 0;
  let warnings = 0;
  for (const f of fs) {
    if (f.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}

/** 1 when any finding is at least as severe as `failOn` (default `"error"`), else 0. */
export function exitCode(fs: readonly Finding[], opts: { readonly failOn?: Severity } = {}): 0 | 1 {
  const { errors, warnings } = summarize(fs);
  const failing = opts.failOn === "warning" ? errors + warnings : errors;
  return failing > 0 ? 1 : 0;
}
