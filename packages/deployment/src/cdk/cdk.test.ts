/**
 * The CDK target: longplay's deploy-command and rollback-trigger tests
 * (infra/test/pipeline-deploy.test.ts), moved with the code and adapted to config (the app, the
 * output and the stack are longplay's, from its deploy.toml). Plus the target's own seams and the
 * provenance context in a real CDK app.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { Aws, type ExecResult } from "../aws.js";
import { LONGPLAY_APP, LONGPLAY_TRIGGERS } from "../test-support/longplay.js";
import {
  otelResourceAttributes,
  PROVENANCE_CONTEXT,
  provenanceContextArgs,
  provenanceFromContext,
} from "./provenance.js";
import { type CdkAppOptions, CdkTarget, cdkArgs } from "./target.js";
import {
  listExistingAlarms,
  MAX_ROLLBACK_TRIGGERS,
  RECENT_ALARM_MINUTES,
  selectRollbackTriggers,
} from "./triggers.js";

const APP: CdkAppOptions = LONGPLAY_APP;
const ARN = (name: string): string => `arn:aws:cloudwatch:eu-west-1:123456789012:alarm:${name}`;
const alarm = (name: string, state = "OK") => ({
  AlarmName: name,
  AlarmArn: ARN(name),
  StateValue: state,
});
const settings = {
  PLATFORM_ALARM_EMAIL: "a@example.com",
  PLATFORM_HOSTED_ZONE_ID: "Z0123456789ABCDEFGHIJ",
  PLATFORM_SITE_BUCKET_NAME: "site-bucket",
};
const ctx = (): string[] => ["-c", `platformSiteBucketName=${settings.PLATFORM_SITE_BUCKET_NAME}`];

describe("the deploy command (step 4)", () => {
  it("is deploy.sh's command: the platform app, its own output directory, the one stack, the settings as -c", () => {
    const args = cdkArgs(APP, "deploy", ctx());
    expect(args.slice(0, 7)).toEqual([
      "--app",
      "node bin/platform.ts",
      "-o",
      "cdk.out.platform",
      "deploy",
      "LongplayPlatformStack",
      "--require-approval",
    ]);
    expect(args).toContain("platformSiteBucketName=site-bucket");
  });

  it("passes the rollback triggers and the monitoring period as the CDK CLI spells them", () => {
    const args = cdkArgs(APP, "deploy", ctx(), [ARN("a"), ARN("b")], 12);
    expect(args.filter((a) => a === "--rollback-trigger-alarm-arns")).toHaveLength(2);
    expect(args).toContain(ARN("a"));
    expect(args.slice(-2)).toEqual(["--monitoring-time-minutes", "12"]);
  });

  it("passes neither flag when there are no triggers, and none to synth", () => {
    expect(cdkArgs(APP, "deploy", ctx())).not.toContain("--monitoring-time-minutes");
    expect(cdkArgs(APP, "synth", ctx(), [ARN("a")])).not.toContain("--rollback-trigger-alarm-arns");
    expect(cdkArgs(APP, "synth", ctx())).not.toContain("--require-approval");
  });

  it("deploys every stack a project names, with the app from cdk.json when it names none", () => {
    expect(
      cdkArgs({ cdk: ["cdk"], dir: ".", output: "o", stacks: ["Dns", "App"] }, "deploy", []),
    ).toEqual(["-o", "o", "deploy", "Dns", "App", "--require-approval", "never"]);
  });

  it("the installed CDK CLI has those two flags", () => {
    const help = execFileSync("pnpm", ["exec", "cdk", "deploy", "--help"], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      encoding: "utf8",
    });
    expect(help).toContain("--rollback-trigger-alarm-arns");
    expect(help).toContain("--monitoring-time-minutes");
  });
});

describe("rollback triggers", () => {
  const wanted = LONGPLAY_TRIGGERS;

  it("are the alarms that exist and are OK, at most 5", () => {
    const sel = selectRollbackTriggers(
      wanted,
      wanted.map((n) => alarm(n)),
    );
    expect(sel.arns).toEqual(wanted.map(ARN));
    expect(sel.arns.length).toBeLessThanOrEqual(MAX_ROLLBACK_TRIGGERS);
    expect(sel.left).toEqual([]);
  });

  it("leave out an alarm that does not exist (it would fail the whole deploy) and one that is not OK (it would roll back the fix)", () => {
    const sel = selectRollbackTriggers(
      ["x-new", "x-firing", "x-fine"],
      [alarm("x-firing", "ALARM"), alarm("x-fine"), alarm("other")],
    );
    expect(sel.arns).toEqual([ARN("x-fine")]);
    expect(sel.left.join("\n")).toMatch(/x-new: does not exist yet/);
    expect(sel.left.join("\n")).toMatch(/x-firing: is ALARM before the deploy/);
  });

  it("leave out an alarm that is OK now but went to ALARM in the last hour (a flapping alarm rolled back the fix once)", () => {
    const sel = selectRollbackTriggers(
      ["x-flapping", "x-fine"],
      [{ ...alarm("x-flapping"), LastAlarmAt: "2026-11-21T10:33:17.125Z" }, alarm("x-fine")],
    );
    expect(sel.arns).toEqual([ARN("x-fine")]);
    expect(sel.left.join("\n")).toMatch(
      /x-flapping: was ALARM at 2026-11-21T10:33:17.125Z, within the last 60 minutes/,
    );
  });

  it("read the state history of the OK triggers only, for the last hour, as the deploy role", () => {
    const calls: string[][] = [];
    const now = new Date("2026-11-21T11:00:00.000Z");
    const exec = (_cmd: string, args: readonly string[]): ExecResult => {
      calls.push([...args]);
      if (args[1] === "describe-alarms")
        return {
          status: 0,
          stdout: JSON.stringify([
            alarm("x-flapping"),
            alarm("x-quiet"),
            alarm("x-firing", "ALARM"),
            alarm("x-other"),
          ]),
          stderr: "",
        };
      const name = args[args.indexOf("--alarm-name") + 1];
      return {
        status: 0,
        stdout: name === "x-flapping" ? '"2026-11-21T10:33:17.125Z"' : "null",
        stderr: "",
      };
    };
    const alarms = listExistingAlarms(
      new Aws("eu-west-1", exec, {}),
      {},
      ["x-flapping", "x-quiet", "x-firing"],
      { prefix: "x-", now },
    );
    const history = calls.filter((a) => a[1] === "describe-alarm-history");
    expect(history.map((a) => a[a.indexOf("--alarm-name") + 1])).toEqual(["x-flapping", "x-quiet"]);
    const first = history[0] ?? [];
    expect(first[first.indexOf("--start-date") + 1]).toBe(
      new Date(now.getTime() - RECENT_ALARM_MINUTES * 60_000).toISOString(),
    );
    expect(alarms.find((a) => a.AlarmName === "x-flapping")?.LastAlarmAt).toBe(
      "2026-11-21T10:33:17.125Z",
    );
    expect(alarms.find((a) => a.AlarmName === "x-quiet")?.LastAlarmAt).toBeUndefined();
    expect(selectRollbackTriggers(["x-flapping", "x-quiet", "x-firing"], alarms).arns).toEqual([
      ARN("x-quiet"),
    ]);
    expect(calls[0]?.slice(0, 4)).toEqual([
      "cloudwatch",
      "describe-alarms",
      "--alarm-name-prefix",
      "x-",
    ]);
  });

  it("are looked up by name when the project gives no prefix, and not at all when it wants none", () => {
    const calls: string[][] = [];
    const exec = (_c: string, args: readonly string[]): ExecResult => {
      calls.push([...args]);
      return { status: 0, stdout: "[]", stderr: "" };
    };
    listExistingAlarms(new Aws("eu-north-1", exec, {}), {}, ["a", "b"]);
    expect(calls[0]?.slice(0, 5)).toEqual([
      "cloudwatch",
      "describe-alarms",
      "--alarm-names",
      "a",
      "b",
    ]);
    calls.length = 0;
    expect(listExistingAlarms(new Aws("eu-north-1", exec, {}), {}, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("stay triggers, as before, when the deploy role cannot read the state history (a pipeline stack not yet redeployed)", () => {
    const exec = (_cmd: string, args: readonly string[]): ExecResult =>
      args[1] === "describe-alarms"
        ? { status: 0, stdout: JSON.stringify([alarm("x-ok")]), stderr: "" }
        : {
            status: 254,
            stdout: "",
            stderr:
              "An error occurred (AccessDenied) when calling the DescribeAlarmHistory operation",
          };
    const alarms = listExistingAlarms(new Aws("eu-west-1", exec, {}), {}, ["x-ok"]);
    expect(alarms[0]?.HistoryError).toMatch(/AccessDenied/);
    expect(selectRollbackTriggers(["x-ok"], alarms).arns).toEqual([ARN("x-ok")]);
  });

  it("stop at five, the most CloudFormation takes", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const sel = selectRollbackTriggers(
      names,
      names.map((n) => alarm(n)),
    );
    expect(sel.arns).toHaveLength(5);
    expect(sel.left[0]).toContain("f:");
  });
});

describe("the CDK target", () => {
  function target(
    exec: (c: string, a: readonly string[], o: { cwd?: string }) => ExecResult,
    root = "/repo",
  ) {
    return new CdkTarget({
      app: {
        cdk: ["pnpm", "--filter", "infra", "exec", "cdk"],
        dir: "infra",
        output: "cdk.out.deploy",
        stacks: ["A", "B"],
      },
      exec,
      aws: new Aws("eu-north-1", exec, {}),
      repoRoot: root,
      specs: [{ key: "K", context: "k" }],
      provenance: {
        commit: "c".repeat(40),
        repositoryUrl: "https://github.com/o/r",
        environment: "production",
      },
      deployEnv: () => ({ WHO: "deploy" }),
      account: () => "123456789012",
      log: () => undefined,
    });
  }

  it("synthesizes with the settings and the provenance, and reads the outputs of every stack's template", async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "cdk-target-"));
    fs.mkdirSync(path.join(root, "infra", "cdk.out.deploy"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "infra", "cdk.out.deploy", "A.template.json"),
      JSON.stringify({ Outputs: { Zone: {} } }),
    );
    fs.writeFileSync(
      path.join(root, "infra", "cdk.out.deploy", "B.template.json"),
      JSON.stringify({ Outputs: { ApiUrl: {} } }),
    );
    const seen: Array<{ args: readonly string[]; cwd?: string | undefined }> = [];
    const t = target((_c, args, o) => {
      seen.push({ args, cwd: o.cwd });
      return { status: 0, stdout: "", stderr: "" };
    }, root);
    const r = await t.synth({ K: "v" });
    expect(r.ok).toBe(true);
    expect([...r.outputs].sort()).toEqual(["ApiUrl", "Zone"]);
    expect(seen[0]?.cwd).toBe(path.join(root, "infra"));
    expect(seen[0]?.args).toEqual([
      "--filter",
      "infra",
      "exec",
      "cdk",
      "-o",
      "cdk.out.deploy",
      "synth",
      "A",
      "B",
      "-c",
      "k=v",
      ...provenanceContextArgs({
        commit: "c".repeat(40),
        repositoryUrl: "https://github.com/o/r",
        environment: "production",
      }),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rolls back from a worktree of the last good commit, installed, with its own commit as the provenance and no triggers", async () => {
    const seen: Array<{ c: string; args: readonly string[] }> = [];
    const t = target((c, args) => {
      seen.push({ c, args });
      return { status: 0, stdout: "", stderr: "" };
    });
    const r = await t.rollback("a".repeat(40), {});
    expect(r.ok).toBe(true);
    expect(seen.map((s) => `${s.c} ${s.args[0]}`)).toEqual([
      "git cat-file",
      "git worktree",
      "pnpm install",
      "pnpm --filter",
    ]);
    const deploy = seen.at(-1)?.args ?? [];
    expect(deploy).toContain(`${PROVENANCE_CONTEXT.commit}=${"a".repeat(40)}`);
    expect(deploy).not.toContain("--rollback-trigger-alarm-arns");
  });

  it("says a rollback failed when the commit cannot be checked out", async () => {
    const t = target((c, args) => ({
      status: c === "git" && args[0] === "worktree" ? 128 : 0,
      stdout: "",
      stderr: "",
    }));
    expect(await t.rollback("a".repeat(40), {})).toMatchObject({
      ok: false,
      detail: expect.stringContaining("could not check out"),
    });
  });
});

describe("provenance in a CDK app", () => {
  const facts = {
    commit: "9bb4f62677da076832417924196766b5006babdb",
    repositoryUrl: "https://github.com/nikovirtala/kiro-remote",
    environment: "production",
  };

  it("reads the four OpenTelemetry attributes from the context the target passes", () => {
    const context = Object.fromEntries(
      (provenanceContextArgs(facts).filter((_, i) => i % 2 === 1) as string[]).map(
        (kv) => kv.split(/=(.*)/s).slice(0, 2) as [string, string],
      ),
    );
    const app = new App({ context });
    const attrs = provenanceFromContext(new Stack(app, "S").node);
    expect(attrs).toEqual({
      "vcs.ref.head.revision": facts.commit,
      "vcs.repository.url.full": facts.repositoryUrl,
      "deployment.environment.name": "production",
      "service.version": facts.commit,
    });
    expect(otelResourceAttributes(attrs ?? {})).toBe(
      `vcs.ref.head.revision=${facts.commit},vcs.repository.url.full=https://github.com/nikovirtala/kiro-remote,deployment.environment.name=production,service.version=${facts.commit}`,
    );
  });

  it("gives nothing to a synth without it, or with only part of it", () => {
    expect(provenanceFromContext(new App().node)).toBeUndefined();
    expect(
      provenanceFromContext(new App({ context: { [PROVENANCE_CONTEXT.commit]: "c" } }).node),
    ).toBeUndefined();
  });

  it("encodes what would break the OTEL_RESOURCE_ATTRIBUTES list", () => {
    expect(otelResourceAttributes({ "service.version": "1.0 beta,x=y%" })).toBe(
      "service.version=1.0%20beta%2Cx%3Dy%25",
    );
  });
});
