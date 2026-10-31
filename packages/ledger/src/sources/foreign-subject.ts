/**
 * A subject of another log, as references into it see it: what a tool needs to check a qualified
 * reference (`<source>:<id>`) and to show its target.
 */
export interface ForeignSubject<S extends string = string> {
  /** The source kind's state or status. */
  readonly status: S;
  /** `ADR-0007`, `?42` or the id. */
  readonly display: string;
  readonly title: string;
  /** Decisions: the decision in force; issues: the canonical issue. */
  readonly effective: string | null;
}
