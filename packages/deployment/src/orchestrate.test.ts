/**
 * longplay's orchestrator tests (infra/test/pipeline-orchestrate.test.ts), moved with the code and
 * adapted to config: the hints are longplay's, "release task" reads "deployment task", and the step
 * is `tasks`. What each test asserts is unchanged.
 */
import { describe, expect, it } from "vitest";
import { FreezeStore, frozenMessage } from "./freeze.js";
import { FREEZE_SCHEMA, type FreezeRecord } from "./records.js";
import type { TaskReport } from "./tasks/runner.js";
import { COMMIT, GOOD, harness, run } from "./test-support/harness.js";

const frozenAt = (reason: string): FreezeRecord => ({
  schema: FREEZE_SCHEMA,
  reason,
  commit: GOOD,
  at: "2026-11-19T09:00:00Z",
  logs: "https://console/old",
  by: "pipeline" as const,
});

describe("a pipeline run", () => {
  it("does everything in order, records the commit as the last good one and lists the finished tasks that can be deleted", async () => {
    const h = harness({
      tasks: async () => ({
        ran: [
          {
            id: "2.6-first-parity-run",
            commit: COMMIT,
            at: "t",
            outcome: "succeeded",
            summary: "ok",
          },
        ],
        skipped: [],
        dryRuns: [],
        notRun: [],
      }),
    });
    const r = await run(h);
    expect(r).toMatchObject({ outcome: "succeeded", exitCode: 0, phase: "succeeded" });
    expect(r.path).toEqual([
      "queued",
      "preflight",
      "deploying",
      "smoking",
      "running-tasks",
      "succeeded",
    ]);
    expect(h.calls).toEqual(["settings", "preflight", "synth", "deploy", "smoke"]);
    expect(h.ledger.good).toMatchObject({ commit: COMMIT, execution: "exec-1" });
    expect(h.freeze.record).toBeUndefined();
    expect(h.notes).toEqual([]);
    expect(h.logs.join("\n")).toContain("release/2.6-first-parity-run.ts");
    expect(h.logs.join("\n")).toContain("deployment tasks run: 2.6-first-parity-run");
    expect(h.ledger.runs.at(-1)).toMatchObject({
      outcome: "succeeded",
      commit: COMMIT,
      phase: "succeeded",
    });
  });

  it("runs the deployment tasks only after the smoke checks pass", async () => {
    const h = harness({ smoke: async () => ({ ok: false, failures: ["FAIL 1.7 x"], counts: {} }) });
    await run(h);
    expect(h.calls).not.toContain("tasks");
  });

  it("names the project in its notifications", async () => {
    const h = harness(
      { deploy: async () => ({ ok: false, detail: "x" }) },
      { project: "kiro-remote" },
    );
    await run(h);
    expect(h.notes[0]?.subject).toBe("kiro-remote deploy pipeline: FROZEN, rolled back");
  });
});

describe("the freeze flag (step 2)", () => {
  it("stops at once when it is set, says so in the output and touches nothing", async () => {
    const h = harness();
    h.freeze.record = frozenAt("the smoke checks failed");
    const r = await run(h);
    expect(r).toMatchObject({ outcome: "frozen", exitCode: 1, phase: "frozen" });
    expect(r.path).toEqual(["queued", "frozen"]);
    expect(h.calls).toEqual([]);
    const text = h.logs.join("\n");
    expect(text).toContain("PIPELINE FROZEN");
    expect(text).toContain("the smoke checks failed");
    expect(text).toContain("scripts/pipeline.sh unfreeze");
    expect(h.ledger.good).toBeUndefined();
    expect(h.notes).toEqual([]); // the person was told when it froze; every merge would repeat it
    expect(h.ledger.runs.at(-1)?.outcome).toBe("frozen");
  });

  it("treats a flag it cannot read as set", async () => {
    const h = harness();
    h.freeze.unreadable = true;
    expect((await run(h)).outcome).toBe("frozen");
    expect(h.calls).toEqual([]);
  });

  it("is not frozen when the flag is absent, and a cleared flag lets the next run deploy", async () => {
    const h = harness();
    h.freeze.record = frozenAt("x");
    expect(await h.freeze.clear()).toBe(true);
    expect((await run(h)).outcome).toBe("succeeded");
  });

  it("FreezeStore.read: only ParameterNotFound means not frozen; any other error is frozen; a plain value is frozen too", async () => {
    const reading = (impl: () => unknown) =>
      new FreezeStore({ send: async () => impl() } as never, "/p/frozen");
    const notFound = Object.assign(new Error("nope"), { name: "ParameterNotFound" });
    expect(await reading(() => Promise.reject(notFound)).read()).toEqual({ frozen: false });
    const denied = await reading(() =>
      Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" })),
    ).read();
    expect(denied).toMatchObject({ frozen: true });
    expect(denied.frozen && denied.note).toContain("AccessDeniedException");
    // longplay's value: no schema, no `by`.
    const info = { reason: "r", commit: "c", at: "t", logs: "l" };
    expect(await reading(() => ({ Parameter: { Value: JSON.stringify(info) } })).read()).toEqual({
      frozen: true,
      record: { schema: FREEZE_SCHEMA, ...info, by: "pipeline" },
    });
    const odd = await reading(() => ({ Parameter: { Value: "yes" } })).read();
    expect(odd).toMatchObject({ frozen: true, record: undefined });
  });

  it("frozenMessage says since when, why, which commit, where to read it and the one command that clears it", () => {
    const text = frozenMessage(
      {
        frozen: true,
        record: {
          schema: FREEZE_SCHEMA,
          reason: "boom",
          commit: "abc",
          at: "2026-11-19",
          logs: "https://x",
          rolledBackTo: "def",
          by: "pipeline",
        },
      },
      "scripts/pipeline.sh unfreeze",
    );
    for (const part of [
      "2026-11-19",
      "boom",
      "abc",
      "rolled back to def",
      "https://x",
      "scripts/pipeline.sh unfreeze",
    ])
      expect(text).toContain(part);
  });
});

describe("refusing to deploy (step 4)", () => {
  it("refuses when a required setting is missing: nothing is deployed, rolled back or frozen, and the topic is told", async () => {
    const h = harness({
      settings: async () => ({
        values: {},
        errors: [
          "PLATFORM_ALARM_EMAIL is not set. A platform deploy without it removes the alarm topic's email subscription.",
        ],
      }),
    });
    const r = await run(h);
    expect(r).toMatchObject({ outcome: "refused", exitCode: 1, phase: "refused" });
    expect(h.calls).toEqual([]);
    expect(h.freeze.record).toBeUndefined();
    expect(h.notes[0]?.message).toContain("PLATFORM_ALARM_EMAIL");
    expect(h.notes[0]?.message).toContain("scripts/pipeline.sh settings");
    expect(h.logs.join("\n")).toContain("refuses to deploy");
  });

  it("refuses when the preflight finds the secret or the site bucket missing", async () => {
    const h = harness({ preflight: async () => ["the site bucket x does not exist"] });
    expect((await run(h)).outcome).toBe("refused");
    expect(h.calls).not.toContain("deploy");
  });

  it("does not deploy a commit whose synth fails, and does not freeze for it", async () => {
    const h = harness({
      synth: async () => ({ ok: false, detail: "cdk exited 1", outputs: new Set() }),
    });
    const r = await run(h);
    expect(r.outcome).toBe("check-failed");
    expect(r.phase).toBe("refused");
    expect(h.calls).not.toContain("deploy");
    expect(h.freeze.record).toBeUndefined();
  });
});

describe("a failed deploy or failed smoke (step 7)", () => {
  it("deploys the last good commit, freezes, and publishes what failed and where to read it", async () => {
    const h = harness({
      smoke: async () => ({
        ok: false,
        failures: [
          "FAIL 1.7 a test run wrote a row (no row)",
          "SKIP 2.6 the nightly parity run: ...",
        ],
        counts: {},
      }),
    });
    h.ledger.good = { commit: GOOD, at: "t", execution: "old" };
    const r = await run(h);
    expect(r).toMatchObject({ outcome: "rolled-back", exitCode: 1, phase: "frozen" });
    expect(h.calls).toContain(`rollback ${GOOD}`);
    expect(h.calls).not.toContain("tasks");
    expect(h.freeze.record).toMatchObject({
      commit: COMMIT,
      rolledBackTo: GOOD,
      logs: "https://console/exec-1",
      by: "pipeline",
    });
    expect(h.freeze.record?.reason).toContain("the smoke checks failed");
    expect(h.ledger.good?.commit).toBe(GOOD); // the failed commit is never the last good one
    expect(h.notes).toHaveLength(1);
    const note = h.notes[0];
    expect(note?.subject).toContain("FROZEN");
    for (const part of [
      COMMIT,
      "the smoke checks failed",
      "FAIL 1.7 a test run wrote a row",
      `last good commit ${GOOD}`,
      "https://console/exec-1",
      "scripts/pipeline.sh unfreeze",
    ])
      expect(note?.message).toContain(part);
  });

  it("does the same for a failed deploy, and skips smoke and tasks", async () => {
    const h = harness({ deploy: async () => ({ ok: false, detail: "cdk exited 1" }) });
    h.ledger.good = { commit: GOOD, at: "t", execution: "old" };
    const r = await run(h);
    expect(r.outcome).toBe("rolled-back");
    expect(h.calls).toEqual(["settings", "preflight", "synth", `rollback ${GOOD}`]);
    expect(h.freeze.record?.reason).toContain("the deploy failed: cdk exited 1");
  });

  it("sets the freeze flag BEFORE it starts the rollback, so a build that dies in the rollback still leaves it frozen", async () => {
    let frozenWhenRollbackStarted = false;
    const h = harness({ deploy: async () => ({ ok: false, detail: "x" }) });
    h.ledger.good = { commit: GOOD, at: "t", execution: "old" };
    h.steps = {
      ...h.steps,
      rollback: async () => {
        frozenWhenRollbackStarted = h.freeze.record !== undefined;
        throw new Error("the build ran out of time");
      },
    };
    const r = await run(h);
    expect(frozenWhenRollbackStarted).toBe(true);
    expect(r.outcome).toBe("rollback-failed");
    expect(h.notes[0]?.message).toContain("THE ROLLBACK TO");
    expect(h.freeze.record).toBeDefined();
  });

  it("reports a rollback that failed, and stays frozen", async () => {
    const h = harness({
      deploy: async () => ({ ok: false, detail: "x" }),
      rollback: async () => ({ ok: false, detail: "cdk exited 1" }),
    });
    h.ledger.good = { commit: GOOD, at: "t", execution: "old" };
    expect((await run(h)).outcome).toBe("rollback-failed");
    expect(h.freeze.record?.rolledBackTo).toBeUndefined();
  });

  it("has nothing to roll back to on the first run, and says so", async () => {
    const h = harness({ deploy: async () => ({ ok: false, detail: "x" }) });
    const r = await run(h);
    expect(r.outcome).toBe("rolled-back");
    expect(h.calls.some((c) => c.startsWith("rollback"))).toBe(false);
    expect(h.notes[0]?.message).toContain("nothing to roll back to");
    expect(h.freeze.record).toBeDefined();
  });

  it("does not redeploy the commit that is itself the last good one", async () => {
    const h = harness({ smoke: async () => ({ ok: false, failures: ["FAIL x"], counts: {} }) });
    h.ledger.good = { commit: COMMIT, at: "t", execution: "old" };
    await run(h);
    expect(h.calls.some((c) => c.startsWith("rollback"))).toBe(false);
    expect(h.notes[0]?.message).toContain("would change nothing");
  });

  it("freezes and tells the topic even when the flag cannot be set or the topic cannot be reached", async () => {
    const h = harness({
      deploy: async () => ({ ok: false, detail: "x" }),
      notify: async () => Promise.reject(new Error("sns down")),
    });
    h.freeze.failSet = true;
    const r = await run(h);
    expect(r.exitCode).toBe(1);
    expect(h.logs.join("\n")).toContain("COULD NOT SET THE FREEZE FLAG");
    expect(h.logs.join("\n")).toContain("could not publish the notification");
  });

  it("treats a step that throws as a failure, not a crash", async () => {
    const h = harness({
      smoke: async () => Promise.reject(new Error("the role could not be assumed")),
    });
    h.ledger.good = { commit: GOOD, at: "t", execution: "old" };
    const r = await run(h);
    expect(r.outcome).toBe("rolled-back");
    expect(h.freeze.record?.reason).toContain("the smoke step crashed");
  });
});

describe("a failed deployment task (step 6)", () => {
  const failing: TaskReport = {
    ran: [],
    skipped: [],
    dryRuns: [],
    failed: {
      id: "3.7-partition-scratch-check",
      commit: COMMIT,
      at: "t",
      outcome: "failed",
      summary: "run failed: layout",
    },
    notRun: ["4.1-seed-demand"],
  };

  it("freezes and tells the topic, and does NOT roll back: tasks move data forward", async () => {
    const h = harness({ tasks: async () => failing });
    h.ledger.good = { commit: GOOD, at: "t", execution: "old" };
    const r = await run(h);
    expect(r).toMatchObject({ outcome: "task-failed", exitCode: 1, phase: "frozen" });
    expect(h.calls.some((c) => c.startsWith("rollback"))).toBe(false);
    expect(h.freeze.record?.reason).toContain("3.7-partition-scratch-check");
    expect(h.freeze.record?.rolledBackTo).toBeUndefined();
    expect(h.ledger.good?.commit).toBe(GOOD); // not recorded as good until everything passes
    const message = h.notes[0]?.message ?? "";
    expect(message).toContain("NOT rolled back");
    expect(message).toContain("4.1-seed-demand");
    expect(message).toContain("https://console/exec-1");
  });

  it("treats a crash of the runner itself the same way", async () => {
    const h = harness({ tasks: async () => Promise.reject(new Error("no such file")) });
    const r = await run(h);
    expect(r.outcome).toBe("task-failed");
    expect(h.calls.some((c) => c.startsWith("rollback"))).toBe(false);
  });
});
