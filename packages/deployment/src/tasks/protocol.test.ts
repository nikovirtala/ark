/**
 * The task protocol with real processes: a TypeScript module through the shim, a Python script
 * shaped like longplay's release tasks, and a plain executable. Plus longplay's executor tests
 * (infra/test/pipeline-release.test.ts, "the real executor") with a fake `Exec`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultExec, type ExecResult } from "../aws.js";
import { discoverTasks, type TaskFile } from "./discover.js";
import { ProcessExecutor, parseNeeds, type TaskContext } from "./protocol.js";

const SAMPLE = path.resolve(import.meta.dirname, "..", "test-support", "sample-project");
const PY = { ".py": ["python3"] };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function taskDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tasks-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

const logs: string[] = [];
const ctx: TaskContext = {
  commit: "abcdef0123456789",
  region: "eu-north-1",
  env: { PATH: process.env.PATH, AWS_ACCESS_KEY_ID: "k" },
  outputs: { TableName: "t1" },
  log: (m) => void logs.push(m),
  aws: () => undefined,
};

describe("the protocol, with real processes", () => {
  const tasks = discoverTasks(path.join(SAMPLE, "tasks"), { interpreters: PY });
  const executor = new ProcessExecutor({
    exec: defaultExec,
    cwd: SAMPLE,
    baseEnv: { PATH: process.env.PATH },
    interpreters: PY,
    envNames: { commit: "LP_RELEASE_COMMIT", outputs: "LP_RELEASE_OUTPUTS" },
  });
  const byId = (id: string): TaskFile => tasks.find((t) => t.id === id) as TaskFile;

  it("finds the three sample tasks, one of each kind", () => {
    expect(tasks.map((t) => [t.id, t.kind])).toEqual([
      ["1.1-count-sessions", "module"],
      ["1.2-seed-defaults", "interpreted"],
      ["1.3-check-shell", "executable"],
    ]);
  });

  it("runs a TypeScript module through the shim: needs, dry run and run, with the commit and outputs from the environment", async () => {
    const t = byId("1.1-count-sessions");
    expect(await executor.needs(t)).toEqual({
      role: "sample-deployment-task-count",
      description: "Counts what a first deploy left behind (a sample).",
      outputs: ["TableName"],
    });
    logs.length = 0;
    expect(await executor.execute(t, "dry-run", ctx)).toEqual({
      summary: "would count the items of t1 for abcdef0",
    });
    expect(logs).toContain("reading t1");
    expect(await executor.execute(t, "run", ctx)).toEqual({ summary: "counted 0 items of t1" });
  });

  it("runs a Python task as longplay's are run: the protocol as is, and longplay's variable names", async () => {
    const t = byId("1.2-seed-defaults");
    expect((await executor.needs(t)).role).toBe("sample-deployment-task-seed");
    expect(await executor.execute(t, "dry-run", ctx)).toEqual({
      summary: "would seed 3 defaults into t1 for abcdef0",
    });
    expect(await executor.execute(t, "run", ctx)).toEqual({
      summary: "seeded 3 defaults into t1 for abcdef0",
    });
  });

  it("runs a plain executable", async () => {
    const t = byId("1.3-check-shell");
    expect((await executor.needs(t)).description).toContain("shell protocol");
    expect(await executor.execute(t, "run", ctx)).toEqual({ summary: "checked 1 thing" });
  });

  it("rejects a TypeScript task that does not export the contract, or returns no summary", async () => {
    const dir = taskDir({
      "2.6-bad.ts": "export const needs = { role: 'x-task-x', description: 'd' };",
      "2.7-none.ts": `export const needs = { role: 'x-task-x', description: 'd' }; export const dryRun = async () => ({}); export const run = async () => ({ summary: "s" });`,
    });
    const [bad, none] = discoverTasks(dir) as [TaskFile, TaskFile];
    const ex = new ProcessExecutor({
      exec: defaultExec,
      cwd: dir,
      baseEnv: { PATH: process.env.PATH },
    });
    await expect(ex.needs(bad)).rejects.toThrow(/exports needs, dryRun and run/);
    await expect(ex.execute(none, "dry-run", ctx)).rejects.toThrow(
      /dryRun returned no \{ summary \}/,
    );
  });

  it("fails a task that throws, with the tail of its error", async () => {
    const dir = taskDir({
      "1.1-boom.ts": `export const needs = { role: 'x-task-x', description: 'd' }; export const dryRun = async () => { throw new Error("the table is missing"); }; export const run = dryRun;`,
    });
    const [t] = discoverTasks(dir) as [TaskFile];
    const ex = new ProcessExecutor({
      exec: defaultExec,
      cwd: dir,
      baseEnv: { PATH: process.env.PATH },
    });
    await expect(ex.execute(t, "dry-run", ctx)).rejects.toThrow(/exit 1: the table is missing/);
  });
});

describe("the executor, with a fake Exec (longplay's tests)", () => {
  const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
  const LONGPLAY_PY = { ".py": ["uv", "run", "--frozen", "--directory", "transform", "python"] };

  it("runs a Python task in the transform project with the role's keys, and reads its last JSON line", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: Record<string, string | undefined>;
      cwd?: string | undefined;
    }> = [];
    const exec = (
      command: string,
      args: readonly string[],
      options: { env: Record<string, string | undefined>; cwd?: string },
    ): ExecResult => {
      calls.push({ command, args, env: options.env, cwd: options.cwd });
      if (args.includes("--needs"))
        return ok('{"role":"longplay-release-partition-check","description":"d"}\n');
      return ok('some output\n{"summary":"done"}\n');
    };
    const [task] = discoverTasks(taskDir({ "3.7-scratch.py": "" }), {
      interpreters: LONGPLAY_PY,
    }) as [TaskFile];
    const ex = new ProcessExecutor({
      exec,
      cwd: "/repo",
      baseEnv: {},
      interpreters: LONGPLAY_PY,
      envNames: { commit: "LP_RELEASE_COMMIT", outputs: "LP_RELEASE_OUTPUTS" },
    });
    expect((await ex.needs(task)).role).toBe("longplay-release-partition-check");
    expect(await ex.execute(task, "run", ctx)).toEqual({ summary: "done" });
    const last = calls.at(-1);
    expect(last?.command).toBe("uv");
    expect(last?.args.slice(0, 5)).toEqual([
      "run",
      "--frozen",
      "--directory",
      "transform",
      "python",
    ]);
    expect(last?.args.at(-1)).toBe("--run");
    expect(last?.env.AWS_ACCESS_KEY_ID).toBe("k");
    expect(last?.env.LP_RELEASE_COMMIT).toBe("abcdef0123456789");
    expect(last?.env.LP_RELEASE_OUTPUTS).toBe('{"TableName":"t1"}');
    expect(last?.env.DEPLOY_TASK_COMMIT).toBe("abcdef0123456789");
    expect(last?.cwd).toBe("/repo");
  });

  it("fails a Python task on a non-zero exit, with the tail of its error", async () => {
    const exec = (): ExecResult => ({ status: 1, stdout: "", stderr: "Traceback\nboom" });
    const [task] = discoverTasks(taskDir({ "3.7-scratch.py": "" }), {
      interpreters: LONGPLAY_PY,
    }) as [TaskFile];
    await expect(
      new ProcessExecutor({ exec, cwd: "/repo", baseEnv: {}, interpreters: LONGPLAY_PY }).execute(
        task,
        "run",
        ctx,
      ),
    ).rejects.toThrow(/exit 1: Traceback boom/);
  });

  it("fails a task that prints no summary line", async () => {
    const [task] = discoverTasks(taskDir({ "3.7-scratch.py": "" }), { interpreters: PY }) as [
      TaskFile,
    ];
    await expect(
      new ProcessExecutor({
        exec: () => ok("done\n"),
        cwd: "/r",
        baseEnv: {},
        interpreters: PY,
      }).execute(task, "run", ctx),
    ).rejects.toThrow(/printed no \{"summary"/);
  });

  it("parses --needs strictly: role and description, outputs a list of names", () => {
    expect(parseNeeds("x", '{"role":"r","description":"d","outputs":["A"]}')).toEqual({
      role: "r",
      description: "d",
      outputs: ["A"],
    });
    expect(() => parseNeeds("x", '{"role":"r"}')).toThrow(/needs must be/);
    expect(() => parseNeeds("x", '{"role":"r","description":"d","outputs":"A"}')).toThrow(
      /outputs/,
    );
    expect(() => parseNeeds("x", "no json")).toThrow(/printed no JSON line/);
  });
});
