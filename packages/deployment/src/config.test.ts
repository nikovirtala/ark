import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, logsUrl, parseConfig } from "./config.js";
import {
  LONGPLAY_APP,
  LONGPLAY_MARKERS,
  LONGPLAY_SMOKE_AFTER,
  LONGPLAY_SMOKE_BEFORE,
  LONGPLAY_SMOKE_COMMAND,
  LONGPLAY_TRIGGERS,
} from "./test-support/longplay.js";

const SAMPLE = path.join(import.meta.dirname, "test-support", "sample-project");
const minimal = {
  project: { name: "p", region: "eu-north-1", repository: "o/r" },
  ledger: { table: "t" },
  freeze: { parameter: "/p/frozen" },
  settings: { prefix: "/p/settings/" },
  roles: { deploy: "d", smoke: "s", task_prefix: "p-task-" },
  smoke: { command: ["node", "smoke.ts"] },
  target: { kind: "cdk", cdk: ["npx", "cdk"], stacks: ["S"] },
};

describe("deploy.toml", () => {
  it("is found from a subdirectory, and fills the defaults the projects agree on", () => {
    const c = loadConfig(undefined, path.join(SAMPLE, "tasks"));
    expect(c.root).toBe(SAMPLE);
    expect(c.raw.ledger.task_key_prefix).toBe("TASK#");
    expect(c.raw.target.output).toBe("cdk.out.deploy");
    expect(c.raw.target.monitoring_minutes).toBe(10);
    expect(c.outputsStack).toBe("SampleStack");
    expect(c.tasksDir).toBe(path.join(SAMPLE, "tasks"));
    expect(c.hints).toEqual({ unfreeze: "deploy unfreeze", settings: "deploy settings" });
  });

  it("names every problem, with its path", () => {
    expect(() => parseConfig({ ...minimal, ledger: {} }, "/r")).toThrow(/ledger.table/);
    expect(() => parseConfig({ ...minimal, surprise: 1 }, "/r")).toThrow(ConfigError);
    expect(() => parseConfig({ ...minimal, freeze: { parameter: "no-slash" } }, "/r")).toThrow(
      /freeze.parameter/,
    );
    expect(() =>
      parseConfig({ ...minimal, target: { ...minimal.target, monitoring_minutes: 500 } }, "/r"),
    ).toThrow(/monitoring_minutes/);
  });

  it("refuses a setting listed twice, a bad pattern, required_when without required, or a dependency that is not a setting", () => {
    const keys = (k: unknown[]) => ({ ...minimal, settings: { prefix: "/p/s/", keys: k } });
    expect(() =>
      parseConfig(
        keys([
          { key: "A", context: "a" },
          { key: "A", context: "b" },
        ]),
        "/r",
      ),
    ).toThrow(/listed twice/);
    expect(() => parseConfig(keys([{ key: "A", context: "a", pattern: "(" }]), "/r")).toThrow(
      /not a regular expression/,
    );
    expect(() =>
      parseConfig(keys([{ key: "A", context: "a", required_when: ["B"] }]), "/r"),
    ).toThrow(/required_when needs required/);
    expect(() =>
      parseConfig(keys([{ key: "A", context: "a", required: "x", required_when: ["B"] }]), "/r"),
    ).toThrow(/B is not a setting/);
  });

  it("refuses a smoke command that runs as a role [roles] does not name", () => {
    expect(() =>
      parseConfig(
        {
          ...minimal,
          smoke: {
            command: ["x"],
            before: [{ name: "n", task: "t", argv: ["y"], role: "record" }],
          },
        },
        "/r",
      ),
    ).toThrow(/not in \[roles\]/);
  });

  it("links a run to its pipeline execution in the console, when the pipeline is named", () => {
    const c = loadConfig(path.join(SAMPLE, "deploy.toml"));
    expect(logsUrl(c, "e-1")).toBe(
      "https://us-east-1.console.aws.amazon.com/codesuite/codepipeline/pipelines/sample-deploy/executions/e-1/timeline?region=us-east-1",
    );
    expect(logsUrl(c, "manual")).toBe("-");
    expect(logsUrl(parseConfig(minimal, "/r"), "e-1")).toBe("-");
  });

  it("says there is no deploy.toml", () => {
    expect(() => loadConfig(undefined, "/")).toThrow(/no deploy.toml/);
  });
});

describe("longplay's pipeline as config", () => {
  const config = loadConfig(
    path.join(import.meta.dirname, "test-support", "longplay-project", "deploy.toml"),
  );

  it("names everything longplay's names.ts hard-codes", () => {
    const r = config.raw;
    expect(r.ledger).toEqual({ table: "longplay-pipeline-ledger", task_key_prefix: "RELEASE#" });
    expect(r.freeze.parameter).toBe("/longplay/pipeline/frozen");
    expect(r.settings.prefix).toBe("/longplay/pipeline/settings/");
    expect(r.roles).toMatchObject({
      deploy: "longplay-pipeline-deploy",
      smoke: "longplay-pipeline-smoke",
      record: "longplay-pipeline-record",
      task_prefix: "longplay-release-",
    });
    expect(r.notify.topic).toBe("longplay-platform-alarms");
    expect(r.tasks.dir).toBe("release");
    expect(r.tasks.env).toEqual({ commit: "LP_RELEASE_COMMIT", outputs: "LP_RELEASE_OUTPUTS" });
    expect(r.target).toMatchObject({
      dir: "infra",
      app: "node bin/platform.ts",
      output: "cdk.out.platform",
      stacks: ["LongplayPlatformStack"],
      monitoring_minutes: 10,
    });
    expect(r.target.rollback_triggers).toHaveLength(5);
    expect(config.hints.unfreeze).toBe("scripts/pipeline.sh unfreeze");
  });

  it("says longplay's smoke stage and CDK app as test-support/longplay.ts does", () => {
    expect(config.raw.smoke.command).toEqual(LONGPLAY_SMOKE_COMMAND);
    expect(config.raw.smoke.markers).toEqual(LONGPLAY_MARKERS);
    expect(config.smokeBefore).toEqual(LONGPLAY_SMOKE_BEFORE);
    expect(config.smokeAfter).toEqual(LONGPLAY_SMOKE_AFTER);
    expect(config.raw.target).toMatchObject(LONGPLAY_APP);
    expect(config.raw.target.rollback_triggers).toEqual(LONGPLAY_TRIGGERS);
  });

  it("has longplay's three required settings, with their effects and patterns", () => {
    expect(config.specs.filter((s) => s.required).map((s) => s.key)).toEqual([
      "PLATFORM_ALARM_EMAIL",
      "PLATFORM_HOSTED_ZONE_ID",
      "PLATFORM_SITE_BUCKET_NAME",
    ]);
    expect(
      config.specs
        .find((s) => s.key === "PLATFORM_HOSTED_ZONE_ID")
        ?.pattern?.test("Z0123456789ABCDEFGHIJ"),
    ).toBe(true);
    expect(config.specs.find((s) => s.key === "PLATFORM_ALARM_EMAIL")?.fallback).toBe(
      "ALARM_EMAIL",
    );
  });
});
