/**
 * The records a deployment keeps: the freeze record (the freeze flag's value), the run record, the
 * task record and the last good commit. They are a contract with every project's ledger and with the
 * tools that read it (draft, the MCP server), so each is typed, versioned and parsed here.
 *
 * Records written before the package existed (longplay's ledger and freeze flag) have no `schema`
 * field. They are version 1: the parse functions accept them and fill in what is derived.
 */

export const FREEZE_SCHEMA = "deployment-freeze/v1";
export const RUN_SCHEMA = "deployment-run/v1";
export const TASK_SCHEMA = "deployment-task/v1";

/** Who set the freeze flag: the pipeline on a failure, or a person with `deploy freeze`. */
export type FreezeSetBy = "pipeline" | "person";

/** The freeze flag's value. Ids, commits, times and one line of reason: never data. */
export interface FreezeRecord {
  readonly schema: typeof FREEZE_SCHEMA;
  /** Why: what failed, in one line, without data. */
  readonly reason: string;
  /** The commit that was being deployed (`-` when a person froze it by hand). */
  readonly commit: string;
  readonly at: string;
  /** Where to read the output (a console URL, or `-`). */
  readonly logs: string;
  /** The commit the environment was rolled back to, when it was. */
  readonly rolledBackTo?: string;
  readonly by: FreezeSetBy;
}

/** What a run's outcome was. `task-failed` reads longplay's `release-failed`. */
export type RunOutcome =
  | "frozen"
  | "refused"
  | "check-failed"
  | "rolled-back"
  | "rollback-failed"
  | "task-failed"
  | "succeeded";

/** Where a run can be: the state machine's phases (machine.ts). The last three are terminal. */
export type RunPhase =
  | "queued"
  | "preflight"
  | "deploying"
  | "smoking"
  | "running-tasks"
  | "succeeded"
  | "refused"
  | "frozen";

export type TerminalPhase = "succeeded" | "refused" | "frozen";

export interface RunRecord {
  readonly schema: typeof RUN_SCHEMA;
  readonly commit: string;
  readonly at: string;
  /** The pipeline execution id, or `manual`. */
  readonly execution: string;
  readonly outcome: RunOutcome;
  /** The terminal phase the run ended in. */
  readonly phase: TerminalPhase;
  /** One line, no data. */
  readonly summary: string;
  /** The environment it deployed to, when the record says (longplay's records do not). */
  readonly environment?: string;
  /** The GitHub deployment id of the run, when one was recorded. */
  readonly deployment?: number;
}

export type TaskOutcome = "succeeded" | "failed" | "dry-run-failed";

export interface TaskRecord {
  readonly id: string;
  readonly commit: string;
  readonly at: string;
  readonly outcome: TaskOutcome;
  /** One line, no data: counts and names. */
  readonly summary: string;
}

/** The commit whose deploy, smoke checks and tasks all passed. */
export interface LastGood {
  readonly commit: string;
  readonly at: string;
  readonly execution: string;
}

const RUN_OUTCOMES: ReadonlySet<string> = new Set([
  "frozen",
  "refused",
  "check-failed",
  "rolled-back",
  "rollback-failed",
  "task-failed",
  "succeeded",
]);

/** The terminal phase each outcome ends in. */
export function phaseOf(outcome: RunOutcome): TerminalPhase {
  switch (outcome) {
    case "succeeded":
      return "succeeded";
    case "refused":
    case "check-failed":
      return "refused";
    default:
      return "frozen";
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * A freeze record from the flag's raw value, or undefined when the value is not one. A caller treats
 * undefined as frozen (the flag holds something), never as not frozen.
 */
export function parseFreezeRecord(text: string): FreezeRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const schema = o.schema;
  if (schema !== undefined && schema !== FREEZE_SCHEMA) return undefined;
  const reason = str(o.reason);
  const commit = str(o.commit);
  const at = str(o.at);
  const logs = str(o.logs);
  if (reason === undefined || commit === undefined || at === undefined || logs === undefined) {
    return undefined;
  }
  const rolledBackTo = str(o.rolledBackTo);
  // longplay's flag has no `by`: its hand freeze writes a reason that starts with "by hand:".
  const by: FreezeSetBy =
    o.by === "person" || o.by === "pipeline"
      ? o.by
      : reason.startsWith("by hand:")
        ? "person"
        : "pipeline";
  return {
    schema: FREEZE_SCHEMA,
    reason,
    commit,
    at,
    logs,
    ...(rolledBackTo !== undefined ? { rolledBackTo } : {}),
    by,
  };
}

/** A run record from a ledger item (`pk = DEPLOY`, `sk = RUN#<at>`), longplay's or the package's. */
export function parseRunRecord(item: Readonly<Record<string, unknown>>): RunRecord | undefined {
  const commit = str(item.commit);
  const at = str(item.at);
  const execution = str(item.execution);
  const summary = str(item.summary);
  let outcome = str(item.outcome);
  // longplay's name for a failed task, from before tasks were "deployment tasks".
  if (outcome === "release-failed") outcome = "task-failed";
  if (
    commit === undefined ||
    at === undefined ||
    execution === undefined ||
    summary === undefined ||
    outcome === undefined ||
    !RUN_OUTCOMES.has(outcome)
  ) {
    return undefined;
  }
  const o = outcome as RunOutcome;
  const environment = str(item.environment);
  const deployment = typeof item.deployment === "number" ? item.deployment : undefined;
  return {
    schema: RUN_SCHEMA,
    commit,
    at,
    execution,
    outcome: o,
    phase: phaseOf(o),
    summary,
    ...(environment !== undefined ? { environment } : {}),
    ...(deployment !== undefined ? { deployment } : {}),
  };
}

const TASK_OUTCOMES: ReadonlySet<string> = new Set(["succeeded", "failed", "dry-run-failed"]);

/** A task record from a ledger item (`pk = <prefix><id>`, `sk = DONE` or `ATTEMPT#<at>`). */
export function parseTaskRecord(item: Readonly<Record<string, unknown>>): TaskRecord | undefined {
  const id = str(item.id);
  const commit = str(item.commit);
  const at = str(item.at);
  const outcome = str(item.outcome);
  const summary = str(item.summary);
  if (
    id === undefined ||
    commit === undefined ||
    at === undefined ||
    summary === undefined ||
    outcome === undefined ||
    !TASK_OUTCOMES.has(outcome)
  ) {
    return undefined;
  }
  return { id, commit, at, outcome: outcome as TaskOutcome, summary };
}

/** One line, clipped: what goes in the ledger. */
export function clip(text: string, max = 1000): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
