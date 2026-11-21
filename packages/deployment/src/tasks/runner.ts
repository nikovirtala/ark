/**
 * Running deployment tasks: one-off steps that run once after a deploy has passed its smoke checks.
 *
 *  1. takes every task whose id is not in the ledger, in task order;
 *  2. assumes the role the task declares (never the deploy role) and gives the task only that role's keys;
 *  3. dry-runs it, then runs it, and records each result in the ledger (id, commit, time, outcome, summary);
 *  4. stops at the first failure and returns it. The caller freezes the pipeline. Nothing is rolled
 *     back: a task moves data forward, and an older commit does not undo that.
 *
 * A task in the ledger never runs again.
 */
import type { Env } from "../aws.js";
import type { LedgerStore } from "../ledger.js";
import type { TaskRecord } from "../records.js";
import type { TaskFile } from "./discover.js";
import type { TaskContext, TaskExecutor, TaskNeeds } from "./protocol.js";

export interface RolePolicy {
  /** Every task role starts with this (`kiro-remote-deployment-task-`, `longplay-release-`). */
  readonly taskRolePrefix: string;
  /** Roles a task may never declare, whatever their name (the deploy role). */
  readonly forbidden?: readonly string[];
}

/** Throws when the task's declaration breaks the rules: a role of the task prefix, never the deploy role. */
export function validateNeeds(
  task: Pick<TaskFile, "id">,
  needs: TaskNeeds,
  policy: RolePolicy,
): void {
  if (!needs || typeof needs.role !== "string" || typeof needs.description !== "string") {
    throw new Error(`${task.id}: needs must be { role, description }`);
  }
  if (!needs.role.startsWith(policy.taskRolePrefix) || policy.forbidden?.includes(needs.role)) {
    throw new Error(
      `${task.id}: it declares role ${needs.role}, but a deployment task runs as a ${policy.taskRolePrefix}* role, never the deploy role`,
    );
  }
}

export interface RunTasksDeps {
  readonly tasks: readonly TaskFile[];
  readonly ledger: LedgerStore;
  readonly executor: TaskExecutor;
  readonly policy: RolePolicy;
  readonly commit: string;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  /** Keys for the declared role. */
  readonly credentialsFor: (roleName: string, session: string) => Env;
  /** The stack outputs a task declared. */
  readonly outputsFor: (names: readonly string[]) => Promise<Record<string, string>>;
  readonly aws: (args: readonly string[], env: Env) => unknown;
  readonly region: string;
  /** Run only this task (by hand). It still must not be in the ledger. */
  readonly only?: string;
  readonly dryRunOnly?: boolean;
}

export interface TaskReport {
  /** Tasks that succeeded in this run. */
  readonly ran: readonly TaskRecord[];
  /** Tasks already in the ledger, skipped. */
  readonly skipped: readonly string[];
  /** The dry runs of a dry-run-only pass. */
  readonly dryRuns: readonly { readonly id: string; readonly summary: string }[];
  /** The first failure. Later tasks did not run. */
  readonly failed?: TaskRecord;
  /** Pending tasks that did not run because an earlier one failed. */
  readonly notRun: readonly string[];
}

export async function runTasks(deps: RunTasksDeps): Promise<TaskReport> {
  const done = await deps.ledger.doneIds();
  const selected = deps.only ? deps.tasks.filter((t) => t.id === deps.only) : deps.tasks;
  if (deps.only && selected.length === 0) throw new Error(`no deployment task ${deps.only}`);
  const skipped = selected.filter((t) => done.has(t.id)).map((t) => t.id);
  const pending = selected.filter((t) => !done.has(t.id));
  const ran: TaskRecord[] = [];
  const dryRuns: { id: string; summary: string }[] = [];
  for (const [i, task] of pending.entries()) {
    const stamp = (): string => deps.now().toISOString();
    const record = (outcome: TaskRecord["outcome"], summary: string): TaskRecord => ({
      id: task.id,
      commit: deps.commit,
      at: stamp(),
      outcome,
      summary,
    });
    let step: "dry-run" | "run" = "dry-run";
    try {
      const needs = await deps.executor.needs(task);
      validateNeeds(task, needs, deps.policy);
      const env = deps.credentialsFor(needs.role, `task-${task.id}`);
      const ctx: TaskContext = {
        commit: deps.commit,
        region: deps.region,
        env,
        outputs: await deps.outputsFor(needs.outputs ?? []),
        log: (m) => deps.log(`[${task.id}] ${m}`),
        aws: (args) => deps.aws(args, env),
      };
      deps.log(`deployment task ${task.id} (${needs.role}): dry run`);
      const dry = await deps.executor.execute(task, "dry-run", ctx);
      deps.log(`deployment task ${task.id}: dry run ok: ${dry.summary}`);
      if (deps.dryRunOnly) {
        dryRuns.push({ id: task.id, summary: dry.summary });
        continue;
      }
      step = "run";
      deps.log(`deployment task ${task.id}: run`);
      const result = await deps.executor.execute(task, "run", ctx);
      const rec = record("succeeded", result.summary);
      await deps.ledger.recordAttempt(rec);
      await deps.ledger.markDone(rec);
      deps.log(`deployment task ${task.id}: done: ${result.summary}`);
      ran.push(rec);
    } catch (err) {
      const rec = record(
        step === "dry-run" ? "dry-run-failed" : "failed",
        `${step === "dry-run" ? "dry run" : "run"} failed: ${(err as Error).message}`,
      );
      await deps.ledger.recordAttempt(rec);
      deps.log(`deployment task ${task.id}: ${rec.summary}`);
      return {
        ran,
        skipped,
        dryRuns,
        failed: rec,
        notRun: pending.slice(i + 1).map((t) => t.id),
      };
    }
  }
  return { ran, skipped, dryRuns, notRun: [] };
}
