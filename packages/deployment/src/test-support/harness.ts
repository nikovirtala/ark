/** A run with scripted steps and in-memory freeze flag and ledger, as longplay's orchestrator tests use it. */
import {
  type Orchestration,
  orchestrate,
  type RunContext,
  type RunProvenance,
  type Steps,
} from "../orchestrate.js";
import type { TaskReport } from "../tasks/runner.js";
import { MemoryFreeze, MemoryLedger } from "../testing/index.js";

/** Records a step call and returns what the step answers. */
function called<T>(calls: string[], name: string, value: T): T {
  calls.push(name);
  return value;
}

export const SETTINGS = {
  PLATFORM_ALARM_EMAIL: "a@example.com",
  PLATFORM_HOSTED_ZONE_ID: "Z0123456789ABCDEFGHIJ",
  PLATFORM_SITE_BUCKET_NAME: "site-bucket",
};
export const COMMIT = "c".repeat(40);
export const GOOD = "a".repeat(40);
/** longplay's hints, so its tests read as they did. */
export const LONGPLAY_HINTS = {
  unfreeze: "scripts/pipeline.sh unfreeze",
  settings: "scripts/pipeline.sh settings",
};

export interface Harness {
  readonly freeze: MemoryFreeze;
  readonly ledger: MemoryLedger;
  readonly calls: string[];
  readonly logs: string[];
  readonly notes: Array<{ subject: string; message: string }>;
  steps: Steps;
  readonly ctx: RunContext;
  provenance?: RunProvenance;
}

export const NO_TASKS: TaskReport = { ran: [], skipped: [], dryRuns: [], notRun: [] };

export function harness(over: Partial<Steps> = {}, ctxOver: Partial<RunContext> = {}): Harness {
  const freeze = new MemoryFreeze();
  const ledger = new MemoryLedger();
  const calls: string[] = [];
  const logs: string[] = [];
  const notes: Array<{ subject: string; message: string }> = [];
  const steps: Steps = {
    settings: async () => called(calls, "settings", { values: SETTINGS, errors: [] }),
    preflight: async () => called(calls, "preflight", []),
    synth: async () =>
      called(calls, "synth", { ok: true, detail: "", outputs: new Set(["PolicyStoreId"]) }),
    deploy: async () => called(calls, "deploy", { ok: true, detail: "" }),
    smoke: async () => called(calls, "smoke", { ok: true, failures: [], counts: {} }),
    tasks: async () => called(calls, "tasks", NO_TASKS),
    rollback: async (commit) => called(calls, `rollback ${commit}`, { ok: true, detail: "" }),
    deletable: async () => ["release/2.6-first-parity-run.ts"],
    notify: async (subject, message) => void notes.push({ subject, message }),
    ...over,
  };
  const ctx: RunContext = {
    project: "longplay",
    commit: COMMIT,
    execution: "exec-1",
    logsUrl: "https://console/exec-1",
    now: () => new Date("2026-11-20T10:00:00Z"),
    log: (m) => void logs.push(m),
    hints: LONGPLAY_HINTS,
    ...ctxOver,
  };
  return { freeze, ledger, calls, logs, notes, steps, ctx };
}

export const run = (h: Harness) => {
  const o: Orchestration = {
    ctx: h.ctx,
    freeze: h.freeze,
    ledger: h.ledger,
    steps: h.steps,
    ...(h.provenance ? { provenance: h.provenance } : {}),
  };
  return orchestrate(o);
};
