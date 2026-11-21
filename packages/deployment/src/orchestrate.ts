/**
 * One pipeline run, as a walk through the state machine (machine.ts) over steps that are injected, so
 * it is unit-tested without AWS:
 *
 *   freeze flag set?             -> frozen at once: deploy nothing, say so
 *   settings and preflight       -> refused when a REQUIRED setting is missing or a resource is (nothing deployed, nothing frozen)
 *   synth with them              -> a commit that does not synth never deploys (refused, nothing frozen)
 *   deploy                       -> on failure: freeze, deploy the last good commit, notify
 *   smoke                        -> on failure: the same
 *   deployment tasks             -> on failure: freeze, notify, and NO rollback (they move data forward)
 *   all passed                   -> record the commit as last good, list the tasks that can be deleted
 *
 * The freeze flag is set BEFORE the rollback starts, so a build that dies half way through still
 * leaves the pipeline frozen. The notification is sent whatever else fails. These are longplay's
 * semantics, unchanged; only the names and the hints are the project's.
 */
import { type Freeze, frozenMessage } from "./freeze.js";
import type { LedgerStore } from "./ledger.js";
import { type Effect, type RunEvent, RunMachine } from "./machine.js";
import type { FreezeRecord, RunOutcome, RunPhase } from "./records.js";
import type { ResolvedSettings } from "./settings.js";
import type { SmokeVerdict } from "./smoke/verdict.js";
import type { TaskReport } from "./tasks/runner.js";

export interface RunHints {
  /** The command that clears the freeze flag, as the project spells it. */
  readonly unfreeze: string;
  /** The command that copies the settings into SSM. */
  readonly settings: string;
}

export const DEFAULT_HINTS: RunHints = { unfreeze: "deploy unfreeze", settings: "deploy settings" };

export interface RunContext {
  /** The project's name, for the notification subjects. */
  readonly project: string;
  readonly environment?: string;
  readonly commit: string;
  readonly execution: string;
  /** Where to read this run's output. */
  readonly logsUrl: string;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  readonly hints?: RunHints;
}

export interface SynthResult {
  readonly ok: boolean;
  readonly detail: string;
  /** The output keys of what would be deployed. */
  readonly outputs: ReadonlySet<string>;
}

export interface StepResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** What a run does. The target's three (synth, deploy, rollback) and the rest of the run. */
export interface Steps {
  settings(): Promise<ResolvedSettings>;
  preflight(settings: Readonly<Record<string, string>>): Promise<readonly string[]>;
  synth(settings: Readonly<Record<string, string>>): Promise<SynthResult>;
  deploy(settings: Readonly<Record<string, string>>): Promise<StepResult>;
  smoke(templateOutputs: ReadonlySet<string>): Promise<SmokeVerdict>;
  tasks(): Promise<TaskReport>;
  /** Deploy `commit` (a checkout of it, installed) with the same settings and no rollback triggers. */
  rollback(commit: string, settings: Readonly<Record<string, string>>): Promise<StepResult>;
  /** Task files whose ids are in the ledger (done, safe to delete). */
  deletable(): Promise<readonly string[]>;
  notify(subject: string, message: string): Promise<void>;
}

/** The GitHub deployment of a run (provenance.ts). Every call is best effort. */
export interface RunProvenance {
  /** The run passed the freeze flag: create the deployment, in progress. Returns its id. */
  start(): Promise<number | undefined>;
  finish(result: { phase: RunPhase; outcome: RunOutcome; summary: string }): Promise<void>;
}

export interface RunResult {
  readonly outcome: RunOutcome;
  readonly phase: RunPhase;
  /** The phases the run went through, from `queued`. */
  readonly path: readonly RunPhase[];
  readonly exitCode: 0 | 1;
  readonly summary: string;
  readonly deployment?: number;
}

export interface Orchestration {
  readonly ctx: RunContext;
  readonly freeze: Freeze;
  readonly ledger: LedgerStore;
  readonly steps: Steps;
  readonly provenance?: RunProvenance;
}

export async function orchestrate(o: Orchestration): Promise<RunResult> {
  const { ctx, freeze, ledger, steps } = o;
  const hints = ctx.hints ?? DEFAULT_HINTS;
  const machine = new RunMachine();
  const subject = (what: string): string => `${ctx.project} deploy pipeline: ${what}`;
  let deployment: number | undefined;
  let started = false;

  const finish = async (outcome: RunOutcome, summary: string): Promise<RunResult> => {
    const phase = machine.phase;
    try {
      await ledger.recordRun({
        commit: ctx.commit,
        at: ctx.now().toISOString(),
        execution: ctx.execution,
        outcome,
        summary,
        ...(ctx.environment !== undefined ? { environment: ctx.environment } : {}),
        ...(deployment !== undefined ? { deployment } : {}),
      });
    } catch (err) {
      ctx.log(`could not write the run to the ledger: ${(err as Error).message}`);
    }
    if (o.provenance && started) {
      try {
        await o.provenance.finish({ phase, outcome, summary });
      } catch (err) {
        ctx.log(`could not record the GitHub deployment status: ${(err as Error).message}`);
      }
    }
    return {
      outcome,
      phase,
      path: machine.path(),
      exitCode: outcome === "succeeded" ? 0 : 1,
      summary,
      ...(deployment !== undefined ? { deployment } : {}),
    };
  };
  const safeNotify = async (subj: string, message: string): Promise<void> => {
    try {
      await steps.notify(subj, message);
    } catch (err) {
      ctx.log(`could not publish the notification: ${(err as Error).message}`);
    }
  };
  /** Fires an event and runs its effects in the machine's order, each with its handler. */
  const fire = async (
    on: RunEvent,
    handlers: Partial<Record<Effect, () => Promise<void>>> = {},
  ): Promise<void> => {
    const t = machine.fire(on);
    for (const effect of t.effects) {
      const handler = handlers[effect];
      if (!handler) throw new Error(`no handler for the effect ${effect} of ${t.from} -> ${t.to}`);
      await handler();
    }
  };

  // 1. The freeze flag, before anything else.
  const state = await freeze.read();
  if (state.frozen) {
    ctx.log(frozenMessage(state, hints.unfreeze));
    await fire("found-frozen");
    return finish("frozen", "the freeze flag is set; nothing was deployed");
  }
  await fire("start");
  started = true;
  if (o.provenance) {
    try {
      deployment = await o.provenance.start();
    } catch (err) {
      ctx.log(`could not record the GitHub deployment: ${(err as Error).message}`);
    }
  }

  // 2. Settings, the preflight and the synth. Nothing is deployed, so nothing is frozen or rolled back.
  const refuse = async (outcome: RunOutcome, reason: string, subj: string, message: string) => {
    await fire("refuse", { notify: () => safeNotify(subj, message) });
    return finish(outcome, reason);
  };
  const { values, errors } = await steps.settings();
  if (errors.length > 0) {
    const text = `The pipeline refuses to deploy: ${errors.join(" ")}`;
    ctx.log(text);
    return refuse(
      "refused",
      errors.join(" "),
      subject("refused to deploy"),
      `${text}\nCommit ${ctx.commit}. Nothing was deployed.\nFix with: ${hints.settings}\nOutput: ${ctx.logsUrl}`,
    );
  }
  const pre = await steps.preflight(values);
  if (pre.length > 0) {
    const text = `The pipeline refuses to deploy: ${pre.join(" ")}`;
    ctx.log(text);
    return refuse(
      "refused",
      pre.join(" "),
      subject("refused to deploy"),
      `${text}\nCommit ${ctx.commit}. Nothing was deployed.\nOutput: ${ctx.logsUrl}`,
    );
  }
  const synth = await steps.synth(values);
  if (!synth.ok) {
    ctx.log(`synth failed: ${synth.detail}`);
    return refuse(
      "check-failed",
      `synth failed: ${synth.detail}`,
      subject("the commit does not synth"),
      `Commit ${ctx.commit} does not synth with the stored settings (${synth.detail}). Nothing was deployed.\nOutput: ${ctx.logsUrl}`,
    );
  }
  await fire("checked");

  // 3. Deploy, then smoke. A failure of either freezes, rolls back to the last good commit and notifies.
  const deploy = await steps.deploy(values).catch((err: unknown) => ({
    ok: false,
    detail: `the deploy step crashed: ${(err as Error).message}`,
  }));
  if (!deploy.ok) return rollBackAndFreeze("deploy-failed", "the deploy failed", [deploy.detail]);
  await fire("deployed");
  const smoke: SmokeVerdict = await steps.smoke(synth.outputs).catch((err: unknown) => ({
    ok: false,
    failures: [`the smoke step crashed: ${(err as Error).message}`],
    counts: {},
  }));
  if (!smoke.ok)
    return rollBackAndFreeze("smoke-failed", "the smoke checks failed", smoke.failures);
  await fire("smoke-passed");

  // 4. Deployment tasks: only now. A failure freezes and does not roll back.
  const tasks: TaskReport = await steps.tasks().catch((err: unknown) => ({
    ran: [],
    skipped: [],
    dryRuns: [],
    notRun: [],
    failed: {
      id: "(task runner)",
      commit: ctx.commit,
      at: ctx.now().toISOString(),
      outcome: "failed" as const,
      summary: `the task runner crashed: ${(err as Error).message}`,
    },
  }));
  if (tasks.failed) {
    const reason = `deployment task ${tasks.failed.id} failed: ${tasks.failed.summary}`;
    ctx.log(reason);
    await fire("task-failed", {
      // As in longplay: a flag that cannot be set here fails the run loudly (the build fails, and its alarm fires).
      "set-freeze": () =>
        freeze.set({
          reason,
          commit: ctx.commit,
          at: ctx.now().toISOString(),
          logs: ctx.logsUrl,
          by: "pipeline",
        }),
      notify: async () => {
        const last = await ledger.lastGood();
        await safeNotify(
          subject("FROZEN, a deployment task failed"),
          [
            reason,
            `Commit ${ctx.commit} is deployed and passed the smoke checks. It was NOT rolled back: a deployment task moves data forward, and an older commit does not undo it.`,
            `Last good commit (all steps passed): ${last?.commit ?? "none yet"}.`,
            tasks.notRun.length > 0 ? `Not run because of it: ${tasks.notRun.join(", ")}.` : "",
            `Output: ${ctx.logsUrl}`,
            `After fixing it, clear the flag with: ${hints.unfreeze} (the failed task runs again on the next deploy).`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    });
    return finish("task-failed", reason);
  }

  // 5. Everything passed.
  const ranText =
    tasks.ran.length > 0
      ? `deployment tasks run: ${tasks.ran.map((r) => r.id).join(", ")}`
      : "no deployment task was pending";
  await fire("tasks-passed", {
    "record-last-good": () =>
      ledger.setLastGood({
        commit: ctx.commit,
        at: ctx.now().toISOString(),
        execution: ctx.execution,
      }),
  });
  ctx.log(`DONE: ${ctx.commit} is the last good commit; ${ranText}.`);
  const deletable = await steps.deletable();
  if (deletable.length > 0) {
    ctx.log(
      `These deployment tasks are in the ledger and their files can be deleted (tidying up, never required):\n  ${deletable.join("\n  ")}`,
    );
  }
  return finish("succeeded", `deployed, smoke passed, ${ranText}`);

  async function rollBackAndFreeze(
    on: "deploy-failed" | "smoke-failed",
    what: string,
    details: readonly string[],
  ): Promise<RunResult> {
    const reason = `${what}: ${details.slice(0, 5).join("; ")}${details.length > 5 ? `; and ${details.length - 5} more` : ""}`;
    ctx.log(`FAILED: ${reason}`);
    const base: Omit<FreezeRecord, "schema"> = {
      reason,
      commit: ctx.commit,
      at: ctx.now().toISOString(),
      logs: ctx.logsUrl,
      by: "pipeline",
    };
    let rollback =
      "no last good commit is recorded, so there is nothing to roll back to (the target has already undone a failed update by itself)";
    let outcome: RunOutcome = "rolled-back";
    await fire(on, {
      // First, so a build that dies during the rollback still leaves the pipeline frozen.
      "set-freeze": async () => {
        try {
          await freeze.set(base);
        } catch (err) {
          ctx.log(`COULD NOT SET THE FREEZE FLAG: ${(err as Error).message}`);
        }
      },
      "roll-back": async () => {
        const lastGood = (await ledger.lastGood())?.commit;
        if (lastGood && lastGood === ctx.commit) {
          rollback = `the last good commit is this one (${lastGood}), so deploying it again would change nothing`;
        } else if (lastGood) {
          ctx.log(`rolling back: deploying the last good commit ${lastGood}`);
          try {
            const r = await steps.rollback(lastGood, values);
            if (r.ok) {
              rollback = `rolled back: the last good commit ${lastGood} is deployed again`;
              await freeze.set({ ...base, rolledBackTo: lastGood }).catch(() => undefined);
            } else {
              outcome = "rollback-failed";
              rollback = `THE ROLLBACK TO ${lastGood} FAILED (${r.detail}): the environment is in whatever state the target left it`;
            }
          } catch (err) {
            outcome = "rollback-failed";
            rollback = `THE ROLLBACK TO ${lastGood} FAILED (${(err as Error).message})`;
          }
        }
        ctx.log(rollback);
      },
      notify: () =>
        safeNotify(
          subject("FROZEN, rolled back"),
          [
            `${what} for commit ${ctx.commit}.`,
            ...details.slice(0, 10).map((d) => `  ${d}`),
            rollback,
            `Output: ${ctx.logsUrl}`,
            `The pipeline is frozen: merges deploy nothing. After fixing it, clear the flag with: ${hints.unfreeze}`,
          ].join("\n"),
        ),
    });
    return finish(outcome, `${reason}. ${rollback}`);
  }
}
