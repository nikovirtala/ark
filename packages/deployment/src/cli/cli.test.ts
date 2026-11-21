/**
 * The deploy CLI with in-memory state and the sample project (test-support/sample-project): what a
 * person sees, what an agent is refused, and a frozen pipeline refusing a deploy.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Aws } from "../aws.js";
import { MemoryFreeze, MemoryLedger } from "../testing/index.js";
import type { Clients } from "../wiring.js";
import { runDeployCli } from "./commands.js";

const SAMPLE = path.resolve(import.meta.dirname, "..", "test-support", "sample-project");

function cli(env: Record<string, string | undefined> = {}) {
  const freeze = new MemoryFreeze();
  const ledger = new MemoryLedger();
  const out: string[] = [];
  const err: string[] = [];
  const ssmCalls: string[] = [];
  const clients = (): Clients =>
    ({
      ssm: {
        send: async (c: { constructor: { name: string } }) => {
          ssmCalls.push(c.constructor.name);
          return { Parameters: [] };
        },
      },
      freeze,
      ledger,
    }) as unknown as Clients;
  const awsCalls: string[][] = [];
  const run = (...argv: string[]) =>
    runDeployCli(
      argv,
      { out: (t) => void out.push(t), err: (t) => void err.push(t) },
      {
        env: { PATH: process.env.PATH, ...env },
        cwd: SAMPLE,
        clients,
        aws: () =>
          new Aws("us-east-1", (_c, args) => {
            awsCalls.push([...args]);
            // The one read a task's dry run makes by hand: the stack outputs it declared.
            if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
              const Outputs = [{ OutputKey: "TableName", OutputValue: "sample-table" }];
              return { status: 0, stdout: JSON.stringify({ Stacks: [{ Outputs }] }), stderr: "" };
            }
            return { status: 1, stdout: "", stderr: "no AWS in this test" };
          }),
        now: () => new Date("2026-11-21T12:00:00Z"),
      },
    );
  return { run, freeze, ledger, out, err, awsCalls, ssmCalls };
}

describe("the deploy CLI", () => {
  it("shows the status: not frozen, no last good commit, the three sample tasks pending", async () => {
    const c = cli();
    expect(await c.run("status")).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("sample (production, us-east-1)");
    expect(text).toContain("Not frozen");
    expect(text).toContain("Last good commit: none yet");
    expect(text).toContain(
      "1.1-count-sessions (pending), 1.2-seed-defaults (pending), 1.3-check-shell (pending)",
    );
  });

  it("prints the status as one typed JSON document", async () => {
    const c = cli();
    expect(await c.run("status", "--json")).toBe(0);
    const doc = JSON.parse(c.out.join("\n"));
    expect(doc).toMatchObject({
      schema: "deployment-status/v1",
      project: "sample",
      freeze: { frozen: false },
      lastGood: null,
    });
  });

  it("freezes by hand with a reason, and unfreezes", async () => {
    const c = cli();
    expect(await c.run("freeze")).toBe(2);
    expect(await c.run("freeze", "drill")).toBe(0);
    expect(c.freeze.record).toMatchObject({ reason: "by hand: drill", by: "person", commit: "-" });
    expect(await c.run("unfreeze")).toBe(0);
    expect(c.out.at(-1)).toContain("Unfrozen");
    expect(await c.run("unfreeze")).toBe(0);
    expect(c.out.at(-1)).toBe("It was not frozen.");
  });

  it("dry-runs a sample task in each protocol, with the caller's credentials, and writes nothing", async () => {
    const c = cli({ GIT_COMMIT: "abcdef0123456789" });
    for (const id of ["1.1-count-sessions", "1.2-seed-defaults", "1.3-check-shell"])
      expect(await c.run("dry-run", id), `${id}: ${[...c.out, ...c.err].join("\n")}`).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain(
      "deployment task 1.1-count-sessions (sample-deployment-task-count): dry run",
    );
    expect(text).toContain("dry run ok: would count the items of sample-table for abcdef0");
    expect(text).toContain("dry run ok: would seed 3 defaults into sample-table for abcdef0");
    expect(text).toContain("dry run ok: would check 1 thing");
    expect(c.awsCalls.map((a) => a.slice(0, 4).join(" "))).toEqual(
      Array(2).fill("cloudformation describe-stacks --stack-name SampleStack"),
    );
    expect(c.ledger.attemptsLog).toEqual([]);
    expect(c.ledger.done.size).toBe(0);
  });

  it("lists the tasks and validates each from its --needs", async () => {
    const c = cli();
    expect(await c.run("tasks", "--check")).toBe(0);
    expect(c.out.join("\n")).toContain(
      "pending 1.2-seed-defaults  ok: sample-deployment-task-seed",
    );
  });

  it("refuses a deploy while frozen: the run stops at the flag, deploys nothing and says why", async () => {
    const c = cli({ COMMIT_ID: "c".repeat(40), EXECUTION_ID: "e-1" });
    await c.freeze.set({
      reason: "the smoke checks failed: FAIL api the API answers",
      commit: "b".repeat(40),
      at: "2026-11-21T11:00:00Z",
      logs: "https://console/old",
      by: "pipeline",
    });
    expect(await c.run("run")).toBe(1);
    const text = c.out.join("\n");
    expect(text).toContain("PIPELINE FROZEN: nothing was deployed, checked or run.");
    expect(text).toContain("the smoke checks failed");
    expect(text).toContain("RESULT: frozen");
    expect(c.awsCalls).toEqual([]);
    expect(c.ledger.runs.at(-1)).toMatchObject({
      outcome: "frozen",
      phase: "frozen",
      execution: "e-1",
      environment: "production",
    });
  });

  it("dry-runs a whole run: it would not deploy while frozen or with a REQUIRED setting missing", async () => {
    const c = cli();
    expect(await c.run("dry-run")).toBe(1);
    const text = c.out.join("\n");
    expect(text).toContain("SAMPLE_SECRET_ARN is not set");
    expect(text).toContain(
      "Pending deployment tasks: 1.1-count-sessions, 1.2-seed-defaults, 1.3-check-shell",
    );
    expect(c.ssmCalls).toEqual(["GetParametersByPathCommand"]);
  });

  it("puts a done task back to pending with forget", async () => {
    const c = cli();
    c.ledger.done.set("1.1-count-sessions", {
      id: "1.1-count-sessions",
      commit: "c",
      at: "t",
      outcome: "succeeded",
      summary: "s",
    });
    expect(await c.run("forget", "1.1-count-sessions")).toBe(0);
    expect(c.ledger.done.size).toBe(0);
  });

  it("refuses an agent what only a person does: run, unfreeze, forget, settings", async () => {
    for (const command of ["run", "unfreeze", "forget", "settings"]) {
      const c = cli({ ARK_AGENT: "kiro" });
      await c.freeze.set({ reason: "r", commit: "c", at: "t", logs: "l", by: "pipeline" });
      expect(await c.run(command, "1.1-count-sessions"), command).toBe(2);
      expect(c.err.join("\n")).toContain("is for people");
      expect(c.freeze.record, command).toBeDefined();
    }
    const reader = cli({ ARK_AGENT: "kiro" });
    expect(await reader.run("status")).toBe(0);
    expect(await reader.run("tasks")).toBe(0);
  });

  it("exits 2 on a usage or config error", async () => {
    const c = cli();
    expect(await c.run()).toBe(2);
    expect(await c.run("nonsense")).toBe(2);
    expect(await c.run("status", "--frobnicate")).toBe(2);
    expect(await c.run("status", "--config", "/no/such/deploy.toml")).toBe(2);
    expect(await c.run("forget")).toBe(2);
  });
});
