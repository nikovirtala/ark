/**
 * longplay's release-task tests (infra/test/pipeline-release.test.ts), moved with the runner and
 * adapted to config: the role prefix is a policy (longplay's `longplay-release-`), and discovery
 * takes the interpreters. What each test asserts is unchanged.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLedger } from "../testing/index.js";
import { deletable, discoverTasks, type TaskFile } from "./discover.js";
import type { TaskContext, TaskExecutor } from "./protocol.js";
import { type RolePolicy, type RunTasksDeps, runTasks, validateNeeds } from "./runner.js";

const LONGPLAY: RolePolicy = {
  taskRolePrefix: "longplay-release-",
  forbidden: ["longplay-pipeline-deploy"],
};
const PY = {
  interpreters: { ".py": ["uv", "run", "--frozen", "--directory", "transform", "python"] },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function releaseDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "release-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

describe("discovering deployment tasks", () => {
  it("orders them by task id, numerically, then slug, whatever the file system returns", () => {
    const dir = releaseDir({
      "10.1-late.ts": "",
      "2.6-first-parity-run.ts": "",
      "3.7-partition-scratch-check.py": "",
      "2.10-later.ts": "",
      "2.6-a.ts": "",
    });
    expect(discoverTasks(dir, PY).map((t) => t.id)).toEqual([
      "2.6-a",
      "2.6-first-parity-run",
      "2.10-later",
      "3.7-partition-scratch-check",
      "10.1-late",
    ]);
    expect(discoverTasks(dir, PY).find((t) => t.id === "3.7-partition-scratch-check")?.kind).toBe(
      "interpreted",
    );
  });

  it("refuses a file that is not named by task id and slug, so a task is never skipped by a typo", () => {
    expect(() => discoverTasks(releaseDir({ "seed-demand.ts": "" }))).toThrow(
      /not named <n>\[.<m>\]-<slug>/,
    );
    expect(() => discoverTasks(releaseDir({ "4.1-Seed.ts": "" }))).toThrow(/not named/);
  });

  it("refuses the same id in two files, ignores README.md and a missing directory", () => {
    expect(() => discoverTasks(releaseDir({ "4.1-x.ts": "", "4.1-x.py": "" }), PY)).toThrow(
      /more than one file/,
    );
    expect(discoverTasks(releaseDir({ "README.md": "" }))).toEqual([]);
    expect(discoverTasks("/does/not/exist")).toEqual([]);
  });

  it("lists the task files whose ids are in the ledger as safe to delete", () => {
    const tasks = discoverTasks(releaseDir({ "2.6-a.ts": "", "3.7-b.py": "" }), PY);
    expect(deletable(tasks, new Set(["2.6-a"])).map((p) => path.basename(p))).toEqual(["2.6-a.ts"]);
  });

  it("takes any number of id parts, and an executable with no extension", () => {
    const dir = releaseDir({ "1-first": "#!/bin/sh\n", "1.2.3-deep.ts": "" });
    chmodSync(path.join(dir, "1-first"), 0o755);
    expect(discoverTasks(dir).map((t) => [t.id, t.kind])).toEqual([
      ["1-first", "executable"],
      ["1.2.3-deep", "module"],
    ]);
  });

  it("refuses a file that is neither a module, nor interpreted, nor executable", () => {
    expect(() => discoverTasks(releaseDir({ "1.1-x.py": "" }))).toThrow(/neither a module/);
  });
});

describe("what a task may declare", () => {
  const task = { id: "4.1-x" };
  it("must run as a role of the task prefix, never the deploy role", () => {
    expect(() =>
      validateNeeds(task, { role: "longplay-pipeline-deploy", description: "d" }, LONGPLAY),
    ).toThrow(/never the deploy role/);
    expect(() =>
      validateNeeds(
        task,
        { role: "cdk-hnb659fds-deploy-role-1-eu-west-1", description: "d" },
        LONGPLAY,
      ),
    ).toThrow();
    expect(() =>
      validateNeeds(task, { role: "longplay-release-seed-demand", description: "d" }, LONGPLAY),
    ).not.toThrow();
    expect(() => validateNeeds(task, { description: "d" } as never, LONGPLAY)).toThrow(
      /needs must be/,
    );
  });

  it("refuses the deploy role even when its name has the task prefix", () => {
    expect(() =>
      validateNeeds(
        task,
        { role: "p-task-deploy", description: "d" },
        { taskRolePrefix: "p-task-", forbidden: ["p-task-deploy"] },
      ),
    ).toThrow(/never the deploy role/);
  });
});

/** A task executor with scripted behaviour, recording the order of dry runs and runs and the role each used. */
function scripted(
  behaviour: Record<string, { dry?: string | Error; run?: string | Error; role?: string }>,
) {
  const events: string[] = [];
  const executor: TaskExecutor = {
    needs: async (t) => ({
      role: behaviour[t.id]?.role ?? `longplay-release-${t.id.replace(/^[\d.]+-/, "")}`,
      description: "d",
      outputs: ["RunsTableName"],
    }),
    execute: async (t, mode, ctx: TaskContext) => {
      events.push(`${mode} ${t.id} as ${ctx.env.ROLE}`);
      const r = mode === "dry-run" ? behaviour[t.id]?.dry : behaviour[t.id]?.run;
      if (r instanceof Error) throw r;
      return { summary: r ?? `${mode} ok` };
    },
  };
  return { events, executor };
}

function deps(
  over: Partial<RunTasksDeps> & { tasks: TaskFile[]; executor: TaskExecutor; ledger: MemoryLedger },
): RunTasksDeps {
  return {
    policy: LONGPLAY,
    commit: "c".repeat(40),
    now: (() => {
      let n = 0;
      return () => new Date(Date.UTC(2026, 10, 20, 10, 0, n++));
    })(),
    log: () => undefined,
    credentialsFor: (role) => ({ ROLE: role }),
    outputsFor: async (names) => Object.fromEntries(names.map((n) => [n, `value-of-${n}`])),
    aws: () => undefined,
    region: "eu-west-1",
    ...over,
  };
}

const files = (...ids: string[]): TaskFile[] =>
  ids.map((id) => ({
    id,
    file: `${id}.ts`,
    kind: "module",
    ext: ".ts",
    order: [Number(id.split(".")[0]), Number(id.split(".")[1]?.split("-")[0])],
  }));

describe("running deployment tasks", () => {
  it("runs each pending task in order, each with a dry run first, as the role it declares, and records each result", async () => {
    const ledger = new MemoryLedger();
    const { events, executor } = scripted({});
    const report = await runTasks(
      deps({
        tasks: files("2.6-first-parity-run", "3.7-scratch", "4.1-seed-demand"),
        executor,
        ledger,
      }),
    );
    expect(events).toEqual([
      "dry-run 2.6-first-parity-run as longplay-release-first-parity-run",
      "run 2.6-first-parity-run as longplay-release-first-parity-run",
      "dry-run 3.7-scratch as longplay-release-scratch",
      "run 3.7-scratch as longplay-release-scratch",
      "dry-run 4.1-seed-demand as longplay-release-seed-demand",
      "run 4.1-seed-demand as longplay-release-seed-demand",
    ]);
    expect(report.ran.map((r) => r.id)).toEqual([
      "2.6-first-parity-run",
      "3.7-scratch",
      "4.1-seed-demand",
    ]);
    expect(report.failed).toBeUndefined();
    const rec = ledger.done.get("3.7-scratch");
    expect(rec).toMatchObject({
      id: "3.7-scratch",
      commit: "c".repeat(40),
      outcome: "succeeded",
      summary: "run ok",
    });
    expect(rec?.at).toMatch(/^2026-11-20T10:00:\d\d\.000Z$/);
    expect(ledger.attemptsLog.map((a) => a.id)).toEqual([
      "2.6-first-parity-run",
      "3.7-scratch",
      "4.1-seed-demand",
    ]);
  });

  it("never runs a task that is in the ledger", async () => {
    const ledger = new MemoryLedger();
    ledger.done.set("2.6-first-parity-run", {
      id: "2.6-first-parity-run",
      commit: "old",
      at: "t",
      outcome: "succeeded",
      summary: "s",
    });
    const { events, executor } = scripted({});
    const report = await runTasks(
      deps({ tasks: files("2.6-first-parity-run", "3.7-scratch"), executor, ledger }),
    );
    expect(events.every((e) => !e.includes("2.6-first-parity-run"))).toBe(true);
    expect(report.skipped).toEqual(["2.6-first-parity-run"]);
    expect(report.ran.map((r) => r.id)).toEqual(["3.7-scratch"]);
    // And a second pass runs nothing at all.
    const again = scripted({});
    const second = await runTasks(
      deps({
        tasks: files("2.6-first-parity-run", "3.7-scratch"),
        executor: again.executor,
        ledger,
      }),
    );
    expect(again.events).toEqual([]);
    expect(second.skipped).toEqual(["2.6-first-parity-run", "3.7-scratch"]);
  });

  it("gives a task the stack outputs it declared, and the keys of its role only", async () => {
    const seen: TaskContext[] = [];
    const executor: TaskExecutor = {
      needs: async () => ({
        role: "longplay-release-x",
        description: "d",
        outputs: ["RunsTableName"],
      }),
      execute: async (_t, _m, ctx) => {
        seen.push(ctx);
        return { summary: "ok" };
      },
    };
    await runTasks(deps({ tasks: files("2.6-x"), executor, ledger: new MemoryLedger() }));
    expect(seen[0]?.outputs).toEqual({ RunsTableName: "value-of-RunsTableName" });
    expect(seen[0]?.env).toEqual({ ROLE: "longplay-release-x" });
  });

  it("a failed dry run stops the run before the task changes anything, and records it", async () => {
    const ledger = new MemoryLedger();
    const { events, executor } = scripted({
      "3.7-scratch": { dry: new Error("a leftover bucket blocks it") },
    });
    const report = await runTasks(
      deps({
        tasks: files("2.6-first-parity-run", "3.7-scratch", "4.1-seed-demand"),
        executor,
        ledger,
      }),
    );
    expect(events).not.toContain("run 3.7-scratch as longplay-release-scratch");
    expect(report.failed).toMatchObject({ id: "3.7-scratch", outcome: "dry-run-failed" });
    expect(report.failed?.summary).toContain("a leftover bucket blocks it");
    expect(report.notRun).toEqual(["4.1-seed-demand"]);
    expect(ledger.done.has("3.7-scratch")).toBe(false);
    expect(ledger.done.has("2.6-first-parity-run")).toBe(true); // what finished before stays finished
  });

  it("a failed run stops at once, is not marked done (so it runs again after a fix) and leaves later tasks alone", async () => {
    const ledger = new MemoryLedger();
    const { events, executor } = scripted({ "3.7-scratch": { run: new Error("layout is wrong") } });
    const report = await runTasks(
      deps({ tasks: files("3.7-scratch", "4.1-seed-demand"), executor, ledger }),
    );
    expect(report.failed).toMatchObject({ id: "3.7-scratch", outcome: "failed" });
    expect(report.notRun).toEqual(["4.1-seed-demand"]);
    expect(events.some((e) => e.includes("4.1-seed-demand"))).toBe(false);
    expect(ledger.done.size).toBe(0);
    expect(ledger.attemptsLog).toHaveLength(1);
    // After the fix it runs again, because it is not in the ledger.
    const fixed = scripted({});
    const second = await runTasks(
      deps({ tasks: files("3.7-scratch", "4.1-seed-demand"), executor: fixed.executor, ledger }),
    );
    expect(second.ran.map((r) => r.id)).toEqual(["3.7-scratch", "4.1-seed-demand"]);
  });

  it("a task that declares the deploy role fails before anything runs as it", async () => {
    const ledger = new MemoryLedger();
    const { events, executor } = scripted({ "4.1-x": { role: "longplay-pipeline-deploy" } });
    const report = await runTasks(deps({ tasks: files("4.1-x"), executor, ledger }));
    expect(events).toEqual([]);
    expect(report.failed?.summary).toContain("never the deploy role");
  });

  it("a dry-run-only pass changes nothing in the ledger, and says what each dry run said", async () => {
    const ledger = new MemoryLedger();
    const { events, executor } = scripted({});
    const report = await runTasks(
      deps({ tasks: files("2.6-a"), executor, ledger, dryRunOnly: true }),
    );
    expect(events).toEqual(["dry-run 2.6-a as longplay-release-a"]);
    expect(report.ran).toEqual([]);
    expect(report.dryRuns).toEqual([{ id: "2.6-a", summary: "dry-run ok" }]);
    expect(ledger.done.size + ledger.attemptsLog.length).toBe(0);
  });

  it("running one task by hand runs only that one, and errors on an id that has no file", async () => {
    const { events, executor } = scripted({});
    await runTasks(
      deps({ tasks: files("2.6-a", "3.7-b"), executor, ledger: new MemoryLedger(), only: "3.7-b" }),
    );
    expect(events.every((e) => e.includes("3.7-b"))).toBe(true);
    await expect(
      runTasks(
        deps({ tasks: files("2.6-a"), executor, ledger: new MemoryLedger(), only: "9.9-nope" }),
      ),
    ).rejects.toThrow(/no deployment task 9.9-nope/);
  });

  it("recording a task twice is refused, so two runs at once cannot both count", async () => {
    const ledger = new MemoryLedger();
    const rec = { id: "2.6-a", commit: "c", at: "t", outcome: "succeeded" as const, summary: "s" };
    await ledger.markDone(rec);
    await expect(ledger.markDone(rec)).rejects.toThrow();
  });
});
