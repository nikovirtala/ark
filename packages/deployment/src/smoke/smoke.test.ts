/**
 * The smoke verdict and stage: longplay's tests (infra/test/pipeline-deploy.test.ts, "the smoke
 * verdict" and "running the smoke stage"), moved with the code and adapted to config (the markers and
 * the commands before and after the checks are longplay's, test-support/longplay.ts). Plus the
 * runner and the helpers moved from verify-platform.ts.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../aws.js";
import {
  LONGPLAY_MARKERS,
  LONGPLAY_SMOKE_AFTER,
  LONGPLAY_SMOKE_BEFORE,
  LONGPLAY_SMOKE_COMMAND,
} from "../test-support/longplay.js";
import {
  changedWithin,
  describeStack,
  isNotFound,
  isReadOnlyCommand,
  render,
  taskOrder,
} from "./helpers.js";
import { dryRunChecks, runChecks, type SmokeCheck, smokeMain } from "./runner.js";
import { runSmokeStage, type SmokeStageDeps } from "./stage.js";
import { judge, parseResults, type Result } from "./verdict.js";

const MARKERS = LONGPLAY_MARKERS;

describe("the smoke verdict (step 5)", () => {
  const r = (status: Result["status"], task: string, name = "n", detail = ""): Result => ({
    task,
    name,
    status,
    detail,
  });
  const none = new Set<string>();

  it("fails on every FAIL, and passes PASS and INFO", () => {
    expect(judge([r("PASS", "1.1"), r("INFO", "1.6")], none, MARKERS).ok).toBe(true);
    const v = judge(
      [r("PASS", "1.1"), r("FAIL", "1.7", "a test run wrote a row", "no row")],
      none,
      MARKERS,
    );
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual(["FAIL 1.7 a test run wrote a row (no row)"]);
    expect(v.counts).toEqual({ PASS: 1, FAIL: 1, SKIP: 0, INFO: 0 });
  });

  it("tolerates a SKIP only for a task that is not in the commit that was deployed", () => {
    expect(judge([r("SKIP", "2.6")], none, MARKERS).ok).toBe(true);
    const deployed = judge(
      [r("SKIP", "2.6", "the nightly parity run")],
      new Set(["ParityReportsBucketName"]),
      MARKERS,
    );
    expect(deployed.ok).toBe(false);
    expect(deployed.failures[0]).toContain("the task is deployed and must not be skipped");
  });

  it("fails a SKIP for a task it has no marker for", () => {
    expect(judge([r("SKIP", "7.7")], none, MARKERS).failures[0]).toContain("no marker output");
  });

  it("reads a check command's JSON, and refuses anything else", () => {
    expect(parseResults([{ task: "1", name: "n", status: "PASS" }])).toEqual([
      { task: "1", name: "n", status: "PASS", detail: "" },
    ]);
    expect(() => parseResults({})).toThrow(/not a list/);
    expect(() => parseResults([{ task: "1", name: "n", status: "GREAT" }])).toThrow(
      /not a check result/,
    );
  });
});

describe("running the smoke stage (longplay's, from its deploy.toml)", () => {
  const out = (stdout: string, status = 0, stderr = ""): ExecResult => ({ status, stdout, stderr });
  const base = (
    exec: SmokeStageDeps["exec"],
    templateOutputs = new Set<string>(),
  ): SmokeStageDeps => ({
    exec,
    repoRoot: "/repo",
    checks: LONGPLAY_SMOKE_COMMAND,
    before: LONGPLAY_SMOKE_BEFORE,
    after: LONGPLAY_SMOKE_AFTER,
    markers: MARKERS,
    templateOutputs,
    envFor: (role) => ({ WHO: role }),
    log: () => undefined,
  });

  it("writes the test run as the record role, then verifies as the smoke role, in that order", () => {
    const calls: Array<{ file: string; who: unknown; table: unknown }> = [];
    const exec = (
      _c: string,
      args: readonly string[],
      o: { env: Record<string, string | undefined> },
    ): ExecResult => {
      calls.push({ file: path.basename(args[0] ?? ""), who: o.env.WHO, table: o.env.RUNS_TABLE });
      return args[0]?.endsWith("verify-platform.ts")
        ? out(JSON.stringify([{ task: "1.1", name: "n", status: "PASS", detail: "" }]))
        : out("RESULT: PASS");
    };
    const verdict = runSmokeStage(base(exec));
    expect(verdict.ok).toBe(true);
    expect(calls).toEqual([
      { file: "record-test-run.ts", who: "record", table: "longplay-platform-runs" },
      { file: "verify-platform.ts", who: "smoke", table: undefined },
    ]);
  });

  it("gives the check command the variables the run passes, beside the smoke role's keys", () => {
    let seen: Record<string, string | undefined> = {};
    const exec = (
      _c: string,
      args: readonly string[],
      o: { env: Record<string, string | undefined> },
    ): ExecResult => {
      if (args[0]?.endsWith("verify-platform.ts")) seen = o.env;
      return out(args[0]?.endsWith("verify-platform.ts") ? "[]" : "ok");
    };
    runSmokeStage({ ...base(exec), checksEnv: { DEPLOY_COMMIT: "abc" } });
    expect(seen).toMatchObject({ WHO: "smoke", DEPLOY_COMMIT: "abc" });
  });

  it("fails when record-test-run fails, without running the checks", () => {
    const exec = (_c: string, args: readonly string[]): ExecResult =>
      args[0]?.endsWith("record-test-run.ts") ? out("", 1, "AccessDenied") : out("[]");
    const verdict = runSmokeStage(base(exec));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("record-test-run");
  });

  it("runs the commands after the checks only for the tasks the deployed commit has, and fails the run when one does not match", () => {
    const ran: string[] = [];
    const exec = (_c: string, args: readonly string[]): ExecResult => {
      const file = path.basename(args[0] ?? "");
      ran.push(`${file} ${args[1] ?? ""}`.trim());
      if (file === "verify-platform.ts") return out("[]");
      if (file === "simulate-demand-policy.ts") return out("3 MISMATCH(ES)", 1);
      return out("OK: 130 decisions match");
    };
    const verdict = runSmokeStage(base(exec, new Set(["DemandBusName"])));
    expect(ran.filter((r) => r.startsWith("simulate"))).toEqual([
      "simulate-demand-policy.ts --deployed",
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain("4.1 simulate-demand-policy.ts --deployed");
  });

  it("fails when the checks print nothing parseable, or exit non-zero with no FAIL in their list", () => {
    const record = out("RESULT: PASS");
    expect(
      runSmokeStage(
        base((_c, a) =>
          a[0]?.endsWith("record-test-run.ts") ? record : out("Traceback", 1, "boom"),
        ),
      ).failures[0],
    ).toContain("nothing parseable");
    const crashed = runSmokeStage(
      base((_c, a) => (a[0]?.endsWith("record-test-run.ts") ? record : out("[]", 1, "half way"))),
    );
    expect(crashed.ok).toBe(false);
    expect(crashed.failures[0]).toContain("no FAIL in their list");
  });
});

describe("the check runner", () => {
  const checks: SmokeCheck[] = [
    {
      task: "stack",
      name: "the stack is healthy",
      run: ({ aws, add }) => {
        const s = describeStack(aws, "S");
        add(
          "stack",
          "the stack is healthy",
          s?.status === "UPDATE_COMPLETE" ? "PASS" : "FAIL",
          s?.status ?? "missing",
        );
      },
    },
    {
      task: "api",
      name: "the API answers",
      run: async ({ fetch, add }) => {
        const res = await fetch("https://api.example.com/openapi.json");
        add("api", "the API answers", res.status === 200 ? "PASS" : "FAIL", `HTTP ${res.status}`);
      },
    },
    {
      task: "boom",
      name: "a check that crashes",
      run: () => {
        throw new Error("no such thing");
      },
    },
  ];
  const aws = (service: string): unknown =>
    service === "cloudformation" ? { Stacks: [{ StackStatus: "UPDATE_COMPLETE" }] } : undefined;
  const fetch200 = (async () => new Response("{}", { status: 200 })) as typeof fetch;

  it("runs every check, and turns one that throws into a FAIL of its own", async () => {
    const results = await runChecks(checks, { aws, fetch: fetch200 });
    expect(results.map((r) => `${r.status} ${r.task}`)).toEqual([
      "PASS stack",
      "PASS api",
      "FAIL boom",
    ]);
    expect(results[2]?.detail).toContain("the check crashed: no such thing");
  });

  it("prints JSON for the stage, and exits 1 on a FAIL", async () => {
    const printed: string[] = [];
    const code = await smokeMain(checks, {
      region: "eu-north-1",
      argv: ["--json"],
      aws,
      print: (t) => void printed.push(t),
    });
    expect(code).toBe(1);
    expect(parseResults(JSON.parse(printed[0] ?? "")).map((r) => r.status)).toEqual([
      "PASS",
      "FAIL",
      "FAIL",
    ]);
  });

  it("dry-runs: every call recorded, none made, each marked read or write", async () => {
    const planned = await dryRunChecks([
      ...checks,
      {
        task: "bad",
        name: "a check that would write",
        run: ({ aws: a }) => void a("dynamodb", "put-item", ["--table-name", "t"]),
      },
    ]);
    expect(
      planned.map((p) => [
        p.task,
        p.calls.map((c) => `${c.readOnly ? "read" : "WRITE"} ${c.call}`),
      ]),
    ).toEqual([
      ["stack", ["read aws cloudformation describe-stacks --stack-name S"]],
      ["api", ["read GET https://api.example.com/openapi.json"]],
      ["boom", []],
      ["bad", ["WRITE aws dynamodb put-item --table-name t"]],
    ]);
    const printed: string[] = [];
    expect(
      await smokeMain(checks, {
        region: "r",
        argv: ["--dry-run"],
        print: (t) => void printed.push(t),
      }),
    ).toBe(0);
    expect(printed.join("\n")).toContain("all read-only; nothing was called");
  });
});

describe("the helpers moved from verify-platform.ts", () => {
  it("allow describe-, get- and list- calls and the named exceptions, and nothing else", () => {
    expect(isReadOnlyCommand("cloudformation", "describe-stacks")).toBe(true);
    expect(isReadOnlyCommand("iam", "simulate-principal-policy")).toBe(true);
    expect(isReadOnlyCommand("dynamodb", "query")).toBe(false);
    expect(isReadOnlyCommand("dynamodb", "query", ["dynamodb query"])).toBe(true);
    expect(isReadOnlyCommand("s3api", "put-object")).toBe(false);
  });

  it("tell a missing thing from a crash", () => {
    expect(isNotFound(new Error("An error occurred (ResourceNotFoundException)"))).toBe(true);
    expect(isNotFound({ stderr: "Stack with id S does not exist" })).toBe(true);
    expect(isNotFound(new Error("AccessDenied"))).toBe(false);
  });

  it("describe a stack, or say it does not exist", () => {
    const stack = describeStack(
      () => ({
        Stacks: [
          {
            StackStatus: "UPDATE_COMPLETE",
            Outputs: [{ OutputKey: "A", OutputValue: "1" }],
            Tags: [{ Key: "project", Value: "p" }],
          },
        ],
      }),
      "S",
    );
    expect(stack).toMatchObject({
      status: "UPDATE_COMPLETE",
      outputs: { A: "1" },
      tags: { project: "p" },
    });
    expect(
      describeStack(() => {
        throw new Error("Stack with id S does not exist");
      }, "S"),
    ).toBeUndefined();
    expect(() =>
      describeStack(() => {
        throw new Error("AccessDenied");
      }, "S"),
    ).toThrow(/AccessDenied/);
  });

  it("changedWithin: a function changed minutes ago is still on its first run; an unreadable one is not", () => {
    const now = () => Date.parse("2026-11-21T12:00:00Z");
    const aws = () => ({ LastModified: "2026-11-21T11:50:00.000+0000" });
    expect(changedWithin(aws, "f", 30, now)).toBe(true);
    expect(changedWithin(aws, "f", 5, now)).toBe(false);
    expect(
      changedWithin(
        () => {
          throw new Error("x");
        },
        "f",
        30,
        now,
      ),
    ).toBe(false);
  });

  it("order task ids numerically, and render one line per result", () => {
    expect(["1.10", "1.9", "2.1"].sort((a, b) => taskOrder(a) - taskOrder(b))).toEqual([
      "1.9",
      "1.10",
      "2.1",
    ]);
    expect(render([{ task: "1.1", name: "n", status: "PASS", detail: "d" }])).toBe(
      "PASS  1.1  n  (d)",
    );
  });
});
