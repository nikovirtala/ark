/**
 * Arbitrary sequences of pipeline runs for the property tests: before each run a person may freeze
 * or unfreeze, and every step of the run (settings, preflight, synth, deploy, smoke, each task's dry
 * run and run, the rollback, the freeze write, the notification) succeeds, fails or throws as the
 * generator says. The runs share one freeze flag and one ledger, and the tasks run through the real
 * task runner, so what one run leaves behind is what the next one starts from.
 */
import fc from "fast-check";
import { orchestrate, type RunResult, type Steps } from "../orchestrate.js";
import type { TaskFile } from "../tasks/discover.js";
import type { TaskExecutor } from "../tasks/protocol.js";
import { runTasks } from "../tasks/runner.js";
import { MemoryFreeze, MemoryLedger } from "../testing/index.js";

/** Records a step call and returns what the step answers. */
function called<T>(calls: string[], name: string, value: T): T {
  calls.push(name);
  return value;
}

export type StepOutcome = "ok" | "fail" | "throw";
export type TaskOutcome = "ok" | "dry-fail" | "run-fail";

export interface RunScript {
  readonly before: "nothing" | "unfreeze" | "freeze";
  readonly unreadable: boolean;
  readonly settings: "ok" | "fail";
  readonly preflight: "ok" | "fail";
  readonly synth: "ok" | "fail";
  readonly deploy: StepOutcome;
  readonly smoke: StepOutcome;
  readonly tasks: readonly TaskOutcome[];
  readonly rollback: StepOutcome;
  readonly freezeSetFails: boolean;
  readonly notifyFails: boolean;
  readonly lastGoodIsThisCommit: boolean;
}

export const TASK_IDS = ["1.1-seed", "1.2-backfill", "2.1-first-run"];

const step = fc.constantFrom<StepOutcome>("ok", "ok", "ok", "fail", "throw");

export const runScript: fc.Arbitrary<RunScript> = fc.record({
  before: fc.constantFrom("nothing", "nothing", "nothing", "unfreeze", "unfreeze", "freeze"),
  unreadable: fc.constantFrom(false, false, false, true),
  settings: fc.constantFrom("ok", "ok", "ok", "fail"),
  preflight: fc.constantFrom("ok", "ok", "ok", "fail"),
  synth: fc.constantFrom("ok", "ok", "ok", "fail"),
  deploy: step,
  smoke: step,
  tasks: fc.array(fc.constantFrom<TaskOutcome>("ok", "ok", "ok", "dry-fail", "run-fail"), {
    minLength: TASK_IDS.length,
    maxLength: TASK_IDS.length,
  }),
  rollback: step,
  freezeSetFails: fc.constantFrom(false, false, false, false, true),
  notifyFails: fc.boolean(),
  lastGoodIsThisCommit: fc.constantFrom(false, false, false, false, true),
});

export const world = fc.array(runScript, { minLength: 1, maxLength: 8 });

/** What one run did, as the properties look at it. */
export interface RunTrace {
  readonly script: RunScript;
  readonly index: number;
  readonly frozenAtStart: boolean;
  readonly doneAtStart: ReadonlySet<string>;
  /** The steps called, in order: deploy, smoke, tasks, rollback <commit>, and every task execution. */
  readonly calls: readonly string[];
  /** How many times the freeze flag was set during the run, and whether it was set at the end. */
  readonly freezeSets: number;
  readonly frozenAtEnd: boolean;
  /** How many times anything cleared the flag during the run (never the run itself). */
  readonly clearsDuringRun: number;
  /** The run's result, or "crashed" when orchestrate() threw (a freeze flag that cannot be set after a task failed, as in longplay). */
  readonly result: RunResult | "crashed";
}

export interface WorldTrace {
  readonly runs: readonly RunTrace[];
  readonly freeze: MemoryFreeze;
  readonly ledger: MemoryLedger;
  /** Every task execution of every run, `<mode> <id>`, in order. */
  readonly executions: readonly string[];
}

const fail = (o: StepOutcome, what: string) => {
  if (o === "throw") throw new Error(`${what} threw`);
  return { ok: o === "ok", detail: `${what} ${o}` };
};

const tasks: TaskFile[] = TASK_IDS.map((id) => ({
  id,
  file: `tasks/${id}.ts`,
  kind: "module",
  ext: ".ts",
  order: id.split("-")[0]?.split(".").map(Number) ?? [],
}));

/** Plays a sequence of runs against one freeze flag and one ledger. */
export async function play(scripts: readonly RunScript[]): Promise<WorldTrace> {
  const freeze = new MemoryFreeze();
  const ledger = new MemoryLedger();
  const executions: string[] = [];
  const runs: RunTrace[] = [];
  for (const [index, script] of scripts.entries()) {
    const commit = `${index}`.padStart(40, "c");
    // A person acts between runs, never during one.
    if (script.before === "unfreeze") await freeze.clear();
    if (script.before === "freeze") {
      await freeze.set({ reason: "by hand: drill", commit: "-", at: "t", logs: "-", by: "person" });
    }
    if (script.lastGoodIsThisCommit) ledger.good = { commit, at: "t", execution: "old" };
    freeze.unreadable = script.unreadable;
    freeze.failSet = script.freezeSetFails;
    const frozenAtStart = (await freeze.read()).frozen;
    const doneAtStart = new Set(ledger.done.keys());
    const setsBefore = freeze.sets.length;
    const clearsBefore = freeze.clears;
    const calls: string[] = [];
    const executor: TaskExecutor = {
      needs: async (t) => ({ role: `p-task-${t.id}`, description: "d" }),
      execute: async (t, mode) => {
        calls.push(`${mode} ${t.id}`);
        executions.push(`${mode} ${t.id}`);
        const outcome = script.tasks[TASK_IDS.indexOf(t.id)] ?? "ok";
        if (mode === "dry-run" && outcome === "dry-fail") throw new Error("dry run failed");
        if (mode === "run" && outcome === "run-fail") throw new Error("run failed");
        return { summary: `${mode} ok` };
      },
    };
    const steps: Steps = {
      settings: async () => ({
        values: {},
        errors: script.settings === "ok" ? [] : ["X is not set."],
      }),
      preflight: async () => (script.preflight === "ok" ? [] : ["the stack does not exist"]),
      synth: async () => ({
        ok: script.synth === "ok",
        detail: "synth",
        outputs: new Set<string>(),
      }),
      deploy: async () => called(calls, "deploy", fail(script.deploy, "deploy")),
      smoke: async () => {
        calls.push("smoke");
        const r = fail(script.smoke, "smoke");
        return { ok: r.ok, failures: r.ok ? [] : ["FAIL x"], counts: {} };
      },
      tasks: async () => {
        calls.push("tasks");
        return runTasks({
          tasks,
          ledger,
          executor,
          policy: { taskRolePrefix: "p-task-" },
          commit,
          now: () => new Date(Date.UTC(2026, 10, 21, 0, 0, index)),
          log: () => undefined,
          credentialsFor: () => ({}),
          outputsFor: async () => ({}),
          aws: () => undefined,
          region: "eu-north-1",
        });
      },
      rollback: async (c) => called(calls, `rollback ${c}`, fail(script.rollback, "rollback")),
      deletable: async () => [],
      notify: async () => {
        if (script.notifyFails) throw new Error("sns down");
      },
    };
    const result: RunResult | "crashed" = await orchestrate({
      ctx: {
        project: "p",
        commit,
        execution: `e${index}`,
        logsUrl: "-",
        now: () => new Date(),
        log: () => undefined,
      },
      freeze,
      ledger,
      steps,
    }).catch(() => "crashed" as const);
    freeze.unreadable = false;
    freeze.failSet = false;
    runs.push({
      script,
      index,
      frozenAtStart,
      doneAtStart,
      calls,
      freezeSets: freeze.sets.length - setsBefore,
      frozenAtEnd: freeze.record !== undefined,
      clearsDuringRun: freeze.clears - clearsBefore,
      result,
    });
  }
  return { runs, freeze, ledger, executions };
}

/** How many sequences each property test plays. */
export const PROPERTY_RUNS = 500;
