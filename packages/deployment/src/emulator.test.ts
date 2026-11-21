/**
 * The deployment's state on the AWS Emulator: the ledger (DynamoDB, with a table shaped like
 * longplay's), the freeze flag and the settings (SSM Parameter Store). The real `Ledger`,
 * `FreezeStore` and settings functions run against the emulator; the task runner runs on top of the
 * real ledger; and longplay's own ledger items, loaded as DynamoDB stores them, read unchanged.
 *
 * What it does NOT show: IAM (the emulator never denies a request signed with its own keys; each
 * project proves its roles with IAM's policy simulator). Skipped when no emulator is installed.
 */
import { BatchWriteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreezeStore } from "./freeze.js";
import { Ledger } from "./ledger.js";
import { FREEZE_SCHEMA } from "./records.js";
import { publishSettings, readSettings, resolveSettings } from "./settings.js";
import type { TaskFile } from "./tasks/discover.js";
import type { TaskExecutor } from "./tasks/protocol.js";
import { runTasks } from "./tasks/runner.js";
import {
  createLedgerTable,
  findEmulator,
  type RunningEmulator,
  startEmulator,
} from "./test-support/emulator.js";
import { LONGPLAY_FREEZE, LONGPLAY_SETTINGS } from "./test-support/longplay.js";
import longplayLedger from "./test-support/longplay-ledger.json" with { type: "json" };

const bin = findEmulator();
const GOOD = "a".repeat(40);
const TABLE = "kiro-remote-deployment-ledger";
const FREEZE = "/kiro-remote/deployment/frozen";
const PREFIX = "/longplay/pipeline/settings/";

describe.skipIf(!bin)("the deployment's state on the AWS Emulator", () => {
  let emu: RunningEmulator;
  let ledger: Ledger;
  let freeze: FreezeStore;

  beforeAll(async () => {
    emu = await startEmulator(bin as string);
    await createLedgerTable(emu.dynamodb, TABLE);
    await createLedgerTable(emu.dynamodb, "longplay-pipeline-ledger");
    ledger = new Ledger(emu.documents, { table: TABLE });
    freeze = new FreezeStore(emu.ssm, FREEZE);
  });
  afterAll(async () => {
    await emu?.stop();
  });

  describe("the ledger", () => {
    const rec = (
      id: string,
      outcome: "succeeded" | "failed" = "succeeded",
      at = "2026-11-20T10:00:00.000Z",
    ) => ({ id, commit: GOOD, at, outcome, summary: `${id} ${outcome}` });

    it("has no task done at first, and no last good commit", async () => {
      expect([...(await ledger.doneIds())]).toEqual([]);
      expect(await ledger.lastGood()).toBeUndefined();
    });

    it("records an attempt, then marks the task done, and a task that is done is listed", async () => {
      await ledger.recordAttempt(rec("2.6-a", "failed", "2026-11-20T10:00:00.000Z"));
      expect((await ledger.doneIds()).has("2.6-a")).toBe(false);
      await ledger.recordAttempt(rec("2.6-a", "succeeded", "2026-11-20T10:05:00.000Z"));
      await ledger.markDone(rec("2.6-a", "succeeded", "2026-11-20T10:05:00.000Z"));
      expect((await ledger.doneIds()).has("2.6-a")).toBe(true);
      expect(await ledger.getDone("2.6-a")).toMatchObject({
        id: "2.6-a",
        commit: GOOD,
        outcome: "succeeded",
        summary: "2.6-a succeeded",
      });
      expect((await ledger.attempts("2.6-a")).map((a) => a.outcome)).toEqual([
        "failed",
        "succeeded",
      ]);
    });

    it("refuses to record a task as done twice, so two runs at once cannot both count", async () => {
      await expect(ledger.markDone(rec("2.6-a"))).rejects.toThrow(/conditional/i);
    });

    it("keeps the other tasks apart, and puts one back to pending when it is forgotten, keeping its history", async () => {
      await ledger.markDone(rec("3.7-b"));
      expect([...(await ledger.doneIds())].sort()).toEqual(["2.6-a", "3.7-b"]);
      expect(await ledger.forget("3.7-b", "2026-11-20T11:00:00.000Z")).toBe(true);
      expect(await ledger.forget("3.7-b", "2026-11-20T11:00:01.000Z")).toBe(false);
      expect([...(await ledger.doneIds())]).toEqual(["2.6-a"]);
      expect((await ledger.attempts("3.7-b")).at(-1)?.summary).toContain("forgotten by hand");
    });

    it("keeps the last good commit, and the runs newest first, with their schema and phase", async () => {
      await ledger.setLastGood({ commit: GOOD, at: "2026-11-20T10:00:00.000Z", execution: "e1" });
      await ledger.setLastGood({
        commit: "b".repeat(40),
        at: "2026-11-20T12:00:00.000Z",
        execution: "e2",
      });
      expect(await ledger.lastGood()).toEqual({
        commit: "b".repeat(40),
        at: "2026-11-20T12:00:00.000Z",
        execution: "e2",
      });
      await ledger.recordRun({
        commit: GOOD,
        at: "2026-11-20T10:00:00.000Z",
        execution: "e1",
        outcome: "succeeded",
        summary: "first",
        environment: "production",
        deployment: 42,
      });
      await ledger.recordRun({
        commit: GOOD,
        at: "2026-11-20T12:00:00.000Z",
        execution: "e2",
        outcome: "rolled-back",
        summary: "second",
      });
      const runs = await ledger.recentRuns(5);
      expect(runs.map((r) => r.summary)).toEqual(["second", "first"]);
      expect(runs[0]).toMatchObject({ schema: "deployment-run/v1", phase: "frozen" });
      expect(runs[1]).toMatchObject({
        environment: "production",
        deployment: 42,
        phase: "succeeded",
      });
    });

    it("clips a long summary instead of failing to write it", async () => {
      await ledger.recordAttempt({ ...rec("9.9-long"), summary: "x".repeat(5000) });
      expect((await ledger.attempts("9.9-long"))[0]?.summary.length).toBeLessThanOrEqual(1000);
    });

    it("carries the task runner: a pending task runs once, is in the ledger, and does not run on the next pass", async () => {
      const ran: string[] = [];
      const executor: TaskExecutor = {
        needs: async () => ({ role: "kiro-remote-deployment-task-x", description: "d" }),
        execute: async (t, mode) => {
          ran.push(`${mode} ${t.id}`);
          return { summary: `${mode} done` };
        },
      };
      const tasks: TaskFile[] = [
        { id: "4.1-seed", file: "x", kind: "module", ext: ".ts", order: [4, 1] },
      ];
      const base = {
        tasks,
        ledger,
        executor,
        policy: { taskRolePrefix: "kiro-remote-deployment-task-" },
        commit: GOOD,
        now: () => new Date("2026-11-20T13:00:00Z"),
        log: () => undefined,
        credentialsFor: () => ({}),
        outputsFor: async () => ({}),
        aws: () => undefined,
        region: "eu-north-1",
      };
      expect((await runTasks(base)).ran.map((r) => r.id)).toEqual(["4.1-seed"]);
      expect((await runTasks(base)).skipped).toEqual(["4.1-seed"]);
      expect(ran).toEqual(["dry-run 4.1-seed", "run 4.1-seed"]);
      expect(await ledger.getDone("4.1-seed")).toMatchObject({ commit: GOOD, summary: "run done" });
    });
  });

  describe("longplay's ledger, as its table holds it", () => {
    let longplay: Ledger;
    beforeAll(async () => {
      const items = longplayLedger.items as unknown as Record<string, { S: string }>[];
      for (let i = 0; i < items.length; i += 25) {
        await emu.dynamodb.send(
          new BatchWriteItemCommand({
            RequestItems: {
              "longplay-pipeline-ledger": items
                .slice(i, i + 25)
                .map((Item) => ({ PutRequest: { Item } })),
            },
          }),
        );
      }
      longplay = new Ledger(emu.documents, {
        table: "longplay-pipeline-ledger",
        taskKeyPrefix: "RELEASE#",
      });
    });

    it("reads the done task, its attempts, the last good commit and every run, unchanged", async () => {
      expect([...(await longplay.doneIds())]).toEqual(["3.7-partition-scratch-check"]);
      expect(await longplay.getDone("3.7-partition-scratch-check")).toMatchObject({
        outcome: "succeeded",
        commit: "f8f0cfdc4ee78ecb5132fc780e7d4920efe241ce",
      });
      expect(
        (await longplay.attempts("3.7-partition-scratch-check")).map((a) => a.outcome),
      ).toEqual(["failed", "succeeded"]);
      expect(await longplay.lastGood()).toEqual({
        commit: "9bb4f62677da076832417924196766b5006babdb",
        at: "2026-11-21T12:45:25.225Z",
        execution: "6882e129-5d64-4454-8ec8-4578192330ab",
      });
      const runs = await longplay.recentRuns(100);
      const items = longplayLedger.items.filter((i) => i.sk.S.startsWith("RUN#"));
      expect(runs).toHaveLength(items.length);
      expect(runs.map((r) => r.outcome)).toContain("task-failed");
      expect(runs.every((r) => r.schema === "deployment-run/v1")).toBe(true);
    });

    it("never runs longplay's done task again", async () => {
      const executor: TaskExecutor = {
        needs: async () => ({ role: "longplay-release-partition-check", description: "d" }),
        execute: async () => ({ summary: "ran" }),
      };
      const tasks: TaskFile[] = [
        {
          id: "3.7-partition-scratch-check",
          file: "release/3.7-partition-scratch-check.py",
          kind: "interpreted",
          ext: ".py",
          order: [3, 7],
        },
      ];
      const report = await runTasks({
        tasks,
        ledger: longplay,
        executor,
        policy: { taskRolePrefix: "longplay-release-" },
        commit: GOOD,
        now: () => new Date(),
        log: () => undefined,
        credentialsFor: () => ({}),
        outputsFor: async () => ({}),
        aws: () => undefined,
        region: "eu-west-1",
      });
      expect(report).toMatchObject({ ran: [], skipped: ["3.7-partition-scratch-check"] });
    });

    it("a DONE item written beside longplay's is refused too", async () => {
      await expect(
        longplay.markDone({
          id: "3.7-partition-scratch-check",
          commit: GOOD,
          at: "t",
          outcome: "succeeded",
          summary: "again",
        }),
      ).rejects.toThrow(/conditional/i);
      // And an item that is not a record is left out of the runs, not a crash.
      await emu.dynamodb.send(
        new PutItemCommand({
          TableName: "longplay-pipeline-ledger",
          Item: { pk: { S: "DEPLOY" }, sk: { S: "RUN#9999" }, note: { S: "not a run" } },
        }),
      );
      expect((await longplay.recentRuns(100)).some((r) => r.at === "9999")).toBe(false);
    });
  });

  describe("the freeze flag", () => {
    it("is not frozen when the parameter does not exist", async () => {
      expect(await freeze.read()).toEqual({ frozen: false });
    });

    it("is frozen once set, with what was written, and the value is a String that holds no data", async () => {
      const info = {
        reason: "the smoke checks failed: FAIL 1.7 x",
        commit: GOOD,
        at: "2026-11-20T10:00:00.000Z",
        logs: "https://console/x",
        rolledBackTo: "b".repeat(40),
        by: "pipeline" as const,
      };
      await freeze.set(info);
      expect(await freeze.read()).toEqual({
        frozen: true,
        record: { schema: FREEZE_SCHEMA, ...info },
      });
      const raw = await emu.ssm.send(new GetParameterCommand({ Name: FREEZE }));
      expect(raw.Parameter?.Type).toBe("String");
    });

    it("is cleared by one command, and clearing twice says it was not frozen", async () => {
      expect(await freeze.clear()).toBe(true);
      expect(await freeze.read()).toEqual({ frozen: false });
      expect(await freeze.clear()).toBe(false);
      await expect(emu.ssm.send(new GetParameterCommand({ Name: FREEZE }))).rejects.toMatchObject({
        name: "ParameterNotFound",
      });
    });

    it("is frozen when what is stored is not what the pipeline wrote", async () => {
      await emu.ssm.send(
        new PutParameterCommand({
          Name: FREEZE,
          Value: "please wait",
          Type: "String",
          Overwrite: true,
        }),
      );
      expect(await freeze.read()).toMatchObject({ frozen: true, record: undefined });
      await freeze.clear();
    });

    it("reads longplay's flag, as longplay wrote it, as frozen by the pipeline", async () => {
      const lp = new FreezeStore(
        emu.ssm,
        "/longplay/pipeline/frozen",
        "scripts/pipeline.sh unfreeze",
      );
      await emu.ssm.send(
        new PutParameterCommand({
          Name: "/longplay/pipeline/frozen",
          Value: LONGPLAY_FREEZE,
          Type: "String",
        }),
      );
      const state = await lp.read();
      expect(state.frozen && state.record?.by).toBe("pipeline");
      expect(state.frozen && state.record?.rolledBackTo).toBe(
        "9bb4f62677da076832417924196766b5006babdb",
      );
    });
  });

  describe("the settings (longplay's schema)", () => {
    const env = {
      PLATFORM_ALARM_EMAIL: "alarms@example.com",
      PLATFORM_HOSTED_ZONE_ID: "Z0123456789ABCDEFGHIJ",
      PLATFORM_SITE_BUCKET_NAME: "site-bucket",
      PLATFORM_BUDGET_USD: "30",
    };

    it("copies deploy.env's settings into SSM and reads them back as the pipeline will", async () => {
      const result = await publishSettings(emu.ssm, PREFIX, LONGPLAY_SETTINGS, {
        ...env,
        SHARED_PASSWORD: "never-copied",
        PLATFORM_API_DOMAIN: "",
      });
      expect([...result.written].sort()).toEqual([
        "PLATFORM_ALARM_EMAIL",
        "PLATFORM_BUDGET_USD",
        "PLATFORM_HOSTED_ZONE_ID",
        "PLATFORM_SITE_BUCKET_NAME",
      ]);
      const stored = await readSettings(emu.ssm, PREFIX);
      expect(stored).toEqual({
        PLATFORM_ALARM_EMAIL: "alarms@example.com",
        PLATFORM_BUDGET_USD: "30",
        PLATFORM_HOSTED_ZONE_ID: "Z0123456789ABCDEFGHIJ",
        PLATFORM_SITE_BUCKET_NAME: "site-bucket",
      });
      expect(JSON.stringify(stored)).not.toContain("never-copied");
      expect(resolveSettings(LONGPLAY_SETTINGS, stored).errors).toEqual([]);
    });

    it("removes a setting the file no longer sets, so SSM says what deploy.sh would pass", async () => {
      const result = await publishSettings(emu.ssm, PREFIX, LONGPLAY_SETTINGS, {
        ...env,
        PLATFORM_BUDGET_USD: "",
      });
      expect(result.removed).toEqual(["PLATFORM_BUDGET_USD"]);
      expect(Object.keys(await readSettings(emu.ssm, PREFIX)).sort()).toEqual([
        "PLATFORM_ALARM_EMAIL",
        "PLATFORM_HOSTED_ZONE_ID",
        "PLATFORM_SITE_BUCKET_NAME",
      ]);
    });

    it("refuses to publish without a required setting and writes nothing", async () => {
      await expect(
        publishSettings(emu.ssm, PREFIX, LONGPLAY_SETTINGS, {
          PLATFORM_ALARM_EMAIL: "a@example.com",
        }),
      ).rejects.toThrow(/PLATFORM_HOSTED_ZONE_ID is not set.*PLATFORM_SITE_BUCKET_NAME is not set/);
      expect(Object.keys(await readSettings(emu.ssm, PREFIX))).toHaveLength(3);
    });

    it("lives under the prefix the runner's policy reads", async () => {
      const raw = await emu.ssm.send(
        new GetParameterCommand({ Name: `${PREFIX}PLATFORM_ALARM_EMAIL` }),
      );
      expect(raw.Parameter?.Value).toBe("alarms@example.com");
    });
  });
});
