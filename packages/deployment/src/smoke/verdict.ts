/**
 * The smoke verdict: what fails a run. A check reports PASS, FAIL, INFO or SKIP for a task.
 *
 *  - every FAIL fails the run;
 *  - a SKIP fails unless the task it names is not in the commit that was just deployed. A SKIP is how a
 *    check says "this task's output is not in the stack": fine for a task that is not built yet, a
 *    failure for a task whose output is in the template that was deployed (the deploy did not do what
 *    the commit says). Which output marks which task is the project's `[smoke.markers]`; a SKIP for a
 *    task with no marker fails too;
 *  - a check command that crashes or prints nothing parseable fails (the stage, stage.ts).
 *
 * PASS and INFO never fail the run.
 */

export type Status = "PASS" | "FAIL" | "INFO" | "SKIP";

export const STATUSES: readonly Status[] = ["PASS", "FAIL", "INFO", "SKIP"];

export interface Result {
  readonly task: string;
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

export interface SmokeVerdict {
  readonly ok: boolean;
  /** The checks that failed the run, one line each: task, name and detail. No more than the check printed. */
  readonly failures: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

export function judge(
  results: readonly Result[],
  templateOutputs: ReadonlySet<string>,
  markers: Readonly<Record<string, string>>,
): SmokeVerdict {
  const failures: string[] = [];
  const counts: Record<string, number> = { PASS: 0, FAIL: 0, SKIP: 0, INFO: 0 };
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === "FAIL")
      failures.push(`FAIL ${r.task} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    if (r.status === "SKIP") {
      const marker = markers[r.task];
      if (marker === undefined) {
        failures.push(
          `SKIP ${r.task} ${r.name}: no marker output is known for task ${r.task}, so its SKIP cannot be told from a missing deploy`,
        );
      } else if (templateOutputs.has(marker)) {
        failures.push(
          `SKIP ${r.task} ${r.name}: the deployed commit has the output ${marker}, so the task is deployed and must not be skipped`,
        );
      }
    }
  }
  return { ok: failures.length === 0, failures, counts };
}

/** The output keys of a CloudFormation template that was synthesized from the deployed commit. */
export function templateOutputKeys(template: { Outputs?: Record<string, unknown> }): Set<string> {
  return new Set(Object.keys(template.Outputs ?? {}));
}

/** Checks a value is a list of results, as a check command prints them with --json. */
export function parseResults(value: unknown): Result[] {
  if (!Array.isArray(value)) throw new Error("not a list");
  return value.map((r, i) => {
    const o = r as Partial<Result> | null;
    if (
      !o ||
      typeof o.task !== "string" ||
      typeof o.name !== "string" ||
      !STATUSES.includes(o.status as Status)
    ) {
      throw new Error(`item ${i} is not a check result`);
    }
    return {
      task: o.task,
      name: o.name,
      status: o.status as Status,
      detail: String(o.detail ?? ""),
    };
  });
}
