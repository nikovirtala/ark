/**
 * The real steps' seams with a fake `Exec` (longplay's "wiring" and "preflight" tests, adapted to
 * config), and the read-side library functions the MCP server will serve.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Aws, type ExecResult } from "./aws.js";
import { loadConfig } from "./config.js";
import { environments, findRun, planRun } from "./status.js";
import type { TaskFile } from "./tasks/discover.js";
import { listTasks, validateTask } from "./tasks/listing.js";
import { MemoryFreeze, MemoryLedger } from "./testing/index.js";
import {
  buildSteps,
  executorFor,
  preflightCheck,
  provenanceFor,
  rolePolicy,
  runContext,
  tasksOf,
} from "./wiring.js";

const here = path.join(import.meta.dirname, "test-support");
const LONGPLAY = loadConfig(path.join(here, "longplay-project", "deploy.toml"));
const SAMPLE = loadConfig(path.join(here, "sample-project", "deploy.toml"));

describe("the preflight (deploy.sh's checks)", () => {
  const fakeAws = (missing: string[]) =>
    new Aws(
      "eu-west-1",
      (_c, args) => {
        const joined = args.join(" ");
        const gone = missing.find((m) => joined.includes(m));
        return gone
          ? { status: 254, stdout: "", stderr: `An error occurred: ${gone} does not exist` }
          : { status: 0, stdout: '"x"', stderr: "" };
      },
      {},
    );
  const check = (missing: string[], settings: Record<string, string>) =>
    LONGPLAY.raw.preflight.flatMap(
      (c) =>
        preflightCheck(
          c,
          settings,
          fakeAws(missing),
          () => ({ status: 0, stdout: "", stderr: "" }),
          {},
          "/repo",
        ) ?? [],
    );

  it("passes when both secrets and the bucket exist", () => {
    expect(check([], { PLATFORM_SITE_BUCKET_NAME: "site" })).toEqual([]);
  });

  it("names a missing secret or bucket, and checks the secrets' default names when none is set", () => {
    const errors = check(["longplay/platform/lastfm", "site"], {
      PLATFORM_SITE_BUCKET_NAME: "site",
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("longplay/platform/lastfm");
    expect(errors[1]).toContain("bucket site");
  });

  it("refuses when the stack a deploy would update does not exist, and runs a project's own check", () => {
    const aws = fakeAws(["KiroRemoteStack"]);
    expect(
      preflightCheck(
        { kind: "stack", name: "KiroRemoteStack" },
        {},
        aws,
        () => ({ status: 0, stdout: "", stderr: "" }),
        {},
        "/r",
      ),
    ).toMatch(/the stack KiroRemoteStack does not exist .* a second one/);
    const failing = (): ExecResult => ({
      status: 1,
      stdout: "",
      stderr: "the zone is not delegated",
    });
    expect(
      preflightCheck(
        { kind: "command", argv: ["node", "check.ts"], why: "the DNS zone is not delegated" },
        {},
        aws,
        failing,
        {},
        "/r",
      ),
    ).toBe("the DNS zone is not delegated: the zone is not delegated");
  });
});

describe("wiring", () => {
  const ctx = {
    project: "longplay",
    commit: "c",
    execution: "e",
    logsUrl: "u",
    now: () => new Date(),
    log: () => undefined,
  };

  it("builds every step, and the steps are the ones the orchestrator expects", () => {
    const steps = buildSteps({
      config: LONGPLAY,
      ctx,
      clients: {
        ssm: {} as never,
        freeze: new MemoryFreeze() as never,
        ledger: new MemoryLedger() as never,
      },
      exec: () => ({ status: 0, stdout: "{}", stderr: "" }),
      aws: new Aws("eu-west-1", () => ({ status: 0, stdout: "{}", stderr: "" }), {}),
    });
    expect(Object.keys(steps).sort()).toEqual([
      "deletable",
      "deploy",
      "notify",
      "preflight",
      "rollback",
      "settings",
      "smoke",
      "synth",
      "tasks",
    ]);
  });

  it("takes the commit and the execution from the pipeline's variables, and refuses a run without a commit", () => {
    expect(runContext(LONGPLAY, { COMMIT_ID: "abc", EXECUTION_ID: "e-1" })).toMatchObject({
      project: "longplay",
      commit: "abc",
      execution: "e-1",
      environment: "production",
    });
    expect(runContext(LONGPLAY, { COMMIT_ID: "abc", EXECUTION_ID: "e-1" }).logsUrl).toContain(
      "/pipelines/longplay-platform-deploy/executions/e-1/",
    );
    expect(() => runContext(LONGPLAY, {})).toThrow(/no commit/);
  });

  it("records no GitHub deployment, and says so, without a token secret", () => {
    const logs: string[] = [];
    expect(
      provenanceFor(
        LONGPLAY,
        { ...ctx, log: (m) => void logs.push(m) },
        new Aws("eu-west-1", () => ({ status: 0, stdout: "", stderr: "" }), {}),
      ),
    ).toBeUndefined();
    expect(logs[0]).toContain("no GitHub deployment is recorded");
  });

  it("publishes a notification to the project's topic, and only logs it when there is none", async () => {
    const calls: string[][] = [];
    const aws = new Aws(
      "eu-west-1",
      (_c, a) => {
        calls.push([...a]);
        return {
          status: 0,
          stdout: a[0] === "sts" ? '{"Account":"123456789012"}' : "{}",
          stderr: "",
        };
      },
      {},
    );
    const steps = buildSteps({
      config: LONGPLAY,
      ctx,
      clients: {
        ssm: {} as never,
        freeze: new MemoryFreeze() as never,
        ledger: new MemoryLedger() as never,
      },
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      aws,
    });
    await steps.notify("subject ✓", "message");
    const publish = calls.find((c) => c[0] === "sns") ?? [];
    expect(publish[publish.indexOf("--topic-arn") + 1]).toBe(
      "arn:aws:sns:eu-west-1:123456789012:longplay-platform-alarms",
    );
    expect(publish[publish.indexOf("--subject") + 1]).toBe("subject  ");
    const logs: string[] = [];
    const quiet = buildSteps({
      config: SAMPLE,
      ctx: { ...ctx, log: (m) => void logs.push(m) },
      clients: {
        ssm: {} as never,
        freeze: new MemoryFreeze() as never,
        ledger: new MemoryLedger() as never,
      },
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      aws,
    });
    await quiet.notify("s", "m");
    expect(logs[0]).toContain("no [notify] topic");
  });
});

describe("the read side (what deploy_tasks, deploy_validate_task, deploy_simulate will serve)", () => {
  it("lists every task with its state, and the done ones whose files are gone", async () => {
    const ledger = new MemoryLedger();
    ledger.done.set("1.2-seed-defaults", {
      id: "1.2-seed-defaults",
      commit: "c",
      at: "t",
      outcome: "succeeded",
      summary: "s",
    });
    ledger.done.set("0.9-old", {
      id: "0.9-old",
      commit: "c",
      at: "t",
      outcome: "succeeded",
      summary: "s",
    });
    const listing = await listTasks(tasksOf(SAMPLE), ledger);
    expect(listing.map((t) => `${t.id} ${t.state}${t.file ? "" : " (deleted)"}`)).toEqual([
      "1.1-count-sessions pending",
      "1.2-seed-defaults done",
      "1.3-check-shell pending",
      "0.9-old done (deleted)",
    ]);
  });

  it("validates a task file from its name and --needs alone", async () => {
    const ex = executorFor(SAMPLE, (await import("./aws.js")).defaultExec, {
      PATH: process.env.PATH,
    });
    const file = (tasksOf(SAMPLE)[1] as TaskFile).file;
    expect(
      await validateTask(file, fs.statSync(file).mode, ex, rolePolicy(SAMPLE), {
        interpreters: SAMPLE.raw.tasks.interpreters,
      }),
    ).toMatchObject({ ok: true, id: "1.2-seed-defaults", kind: "interpreted" });
    const wrongRole = await validateTask(file, fs.statSync(file).mode, ex, {
      taskRolePrefix: "other-",
    });
    expect(wrongRole.ok).toBe(false);
    expect(await validateTask("/x/Bad-Name.ts", 0o644, ex, rolePolicy(SAMPLE))).toMatchObject({
      ok: false,
      problems: [expect.stringContaining("is not named")],
    });
  });

  it("plans a run without running it: frozen, missing settings, pending tasks", async () => {
    const freeze = new MemoryFreeze();
    const ledger = new MemoryLedger();
    const plan = await planRun({
      config: SAMPLE,
      freeze,
      ledger,
      tasks: tasksOf(SAMPLE),
      storedSettings: async () => ({
        SAMPLE_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:s",
      }),
    });
    expect(plan).toMatchObject({
      schema: "deployment-plan/v1",
      wouldDeploy: true,
      pendingTasks: ["1.1-count-sessions", "1.2-seed-defaults", "1.3-check-shell"],
    });
    expect(plan.settings.values.SAMPLE_DOMAIN).toBe("sample.example.com");
    await freeze.set({ reason: "r", commit: "c", at: "t", logs: "l", by: "person" });
    expect(
      (
        await planRun({
          config: SAMPLE,
          freeze,
          ledger,
          tasks: [],
          storedSettings: async () => ({}),
        })
      ).stops,
    ).toHaveLength(2);
  });

  it("finds a run by its time or its execution, and lists the environments", async () => {
    const ledger = new MemoryLedger();
    await ledger.recordRun({
      commit: "c",
      at: "2026-11-21T10:00:00Z",
      execution: "e-9",
      outcome: "succeeded",
      summary: "s",
    });
    expect((await findRun(ledger, "e-9"))?.at).toBe("2026-11-21T10:00:00Z");
    expect(await findRun(ledger, "nope")).toBeUndefined();
    expect(environments(LONGPLAY)).toEqual([
      {
        name: "production",
        region: "eu-west-1",
        ledgerTable: "longplay-pipeline-ledger",
        freezeParameter: "/longplay/pipeline/frozen",
        settingsPrefix: "/longplay/pipeline/settings/",
        stacks: ["LongplayPlatformStack"],
      },
    ]);
  });
});
