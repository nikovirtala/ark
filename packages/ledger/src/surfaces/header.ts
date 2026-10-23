/**
 * The state line a tool prints before a subject, so a reader (human or agent) sees whether it is
 * in force. ledger gives the shape; the wording is the kind's.
 */
export interface StateHeader {
  /** For example `ADR-0001 (a7c2m9xd) · superseded`. */
  readonly line: string;
  /** `null` for active subjects. */
  readonly warning: string | null;
}

/** The line, then the warning if any, each ending with a newline. */
export function renderStateHeader(h: StateHeader): string {
  return h.warning === null ? `${h.line}\n` : `${h.line}\n${h.warning}\n`;
}
