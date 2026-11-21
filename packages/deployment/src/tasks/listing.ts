/**
 * The read side of deployment tasks, as library functions: which tasks exist and which are done
 * (`deploy tasks`, later `deploy_tasks`), and whether one file is a valid task (`deploy_validate_task`).
 * Neither runs a task: validation asks the file for `--needs` and nothing else.
 */
import type { LedgerStore } from "../ledger.js";
import type { TaskRecord } from "../records.js";
import { classifyTaskFile, type DiscoverOptions, type TaskFile } from "./discover.js";
import type { TaskExecutor, TaskNeeds } from "./protocol.js";
import { type RolePolicy, validateNeeds } from "./runner.js";

export interface TaskListing {
  readonly id: string;
  /** The file, or undefined for a task that is done and whose file was deleted. */
  readonly file: string | undefined;
  readonly state: "done" | "pending";
  readonly done?: TaskRecord;
}

/** Every task in the directory, pending or done, then the done ones whose files are gone. */
export async function listTasks(
  tasks: readonly TaskFile[],
  ledger: LedgerStore,
): Promise<TaskListing[]> {
  const done = await ledger.doneIds();
  const out: TaskListing[] = [];
  for (const t of tasks) {
    if (!done.has(t.id)) {
      out.push({ id: t.id, file: t.file, state: "pending" });
      continue;
    }
    const rec = await ledger.getDone(t.id);
    out.push({ id: t.id, file: t.file, state: "done", ...(rec ? { done: rec } : {}) });
  }
  for (const id of [...done].sort()) {
    if (tasks.some((t) => t.id === id)) continue;
    const rec = await ledger.getDone(id);
    out.push({ id, file: undefined, state: "done", ...(rec ? { done: rec } : {}) });
  }
  return out;
}

export interface TaskValidation {
  readonly ok: boolean;
  readonly id: string | undefined;
  readonly kind: TaskFile["kind"] | undefined;
  readonly needs: TaskNeeds | undefined;
  readonly problems: readonly string[];
}

/** Checks a task file's name, kind and declaration. Runs `--needs` only. */
export async function validateTask(
  file: string,
  mode: number,
  executor: TaskExecutor,
  policy: RolePolicy,
  options: DiscoverOptions = {},
): Promise<TaskValidation> {
  const name = file.split("/").pop() ?? file;
  const c = classifyTaskFile(name, mode, options);
  if ("error" in c)
    return { ok: false, id: undefined, kind: undefined, needs: undefined, problems: [c.error] };
  const task: TaskFile = { id: c.id, file, kind: c.kind, ext: c.ext, order: c.order };
  try {
    const needs = await executor.needs(task);
    validateNeeds(task, needs, policy);
    return { ok: true, id: c.id, kind: c.kind, needs, problems: [] };
  } catch (err) {
    return {
      ok: false,
      id: c.id,
      kind: c.kind,
      needs: undefined,
      problems: [(err as Error).message],
    };
  }
}
