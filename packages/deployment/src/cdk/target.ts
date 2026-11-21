/**
 * The CDK target: `cdk synth` and `cdk deploy` of a project's stacks the way its deploy script runs
 * them (same app, same output directory, the settings as `-c` flags), plus the provenance context,
 * the rollback triggers on deploy, and a rollback that deploys the last good commit from a
 * `git worktree` of it, with no triggers.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Aws, Env, Exec } from "../aws.js";
import type { StepResult, SynthResult } from "../orchestrate.js";
import type { ProvenanceFacts } from "../provenance.js";
import { contextArgs, type SettingSpec } from "../settings.js";
import { templateOutputKeys } from "../smoke/verdict.js";
import type { Target } from "../target.js";
import { provenanceContextArgs } from "./provenance.js";
import {
  DEFAULT_MONITORING_MINUTES,
  listExistingAlarms,
  selectRollbackTriggers,
} from "./triggers.js";

export interface CdkAppOptions {
  /** The command that runs the CDK CLI, from the repository root (`["pnpm", "--filter", "infra", "exec", "cdk"]`). */
  readonly cdk: readonly string[];
  /** The directory the CDK CLI runs in, relative to the repository root (where cdk.json is). */
  readonly dir: string;
  /** `--app`. Default: the app in cdk.json. */
  readonly app?: string;
  /** `-o`, relative to `dir`. */
  readonly output: string;
  /** The stacks to synth and deploy. */
  readonly stacks: readonly string[];
}

/** The arguments after the CDK CLI for `synth` or `deploy` of the stacks. */
export function cdkArgs(
  app: CdkAppOptions,
  command: "synth" | "deploy",
  context: readonly string[],
  triggers: readonly string[] = [],
  monitoringMinutes = DEFAULT_MONITORING_MINUTES,
): string[] {
  const args = [...(app.app ? ["--app", app.app] : []), "-o", app.output, command, ...app.stacks];
  if (command === "deploy") args.push("--require-approval", "never");
  args.push(...context);
  if (command === "deploy" && triggers.length > 0) {
    for (const arn of triggers) args.push("--rollback-trigger-alarm-arns", arn);
    args.push("--monitoring-time-minutes", String(monitoringMinutes));
  }
  return args;
}

export interface CdkTargetOptions {
  readonly app: CdkAppOptions;
  readonly exec: Exec;
  readonly aws: Aws;
  readonly repoRoot: string;
  readonly specs: readonly SettingSpec[];
  /** The facts every synth and deploy passes into the app (the commit is the one being deployed). */
  readonly provenance?: Omit<ProvenanceFacts, "commit"> & { readonly commit: string };
  /** The deploy role's environment, fresh for every call (a role session lasts an hour). */
  readonly deployEnv: () => Env;
  readonly account: () => string;
  readonly log: (message: string) => void;
  /** The alarms to pass as rollback triggers, by name, in order of preference. */
  readonly rollbackTriggers?: readonly string[];
  /** List the alarms by this prefix instead of by name (longplay's `longplay-platform-`). */
  readonly alarmPrefix?: string;
  readonly monitoringMinutes?: number;
  /** The install command of a checkout of the last good commit. Default: `pnpm install --frozen-lockfile`. */
  readonly install?: readonly string[];
  readonly now?: () => Date;
}

export class CdkTarget implements Target {
  private readonly o: CdkTargetOptions;

  constructor(options: CdkTargetOptions) {
    this.o = options;
  }

  private context(settings: Readonly<Record<string, string>>, commit?: string): string[] {
    const args = contextArgs(this.o.specs, settings);
    if (this.o.provenance) {
      const facts = { ...this.o.provenance, ...(commit ? { commit, version: commit } : {}) };
      args.push(...provenanceContextArgs(facts));
    }
    return args;
  }

  /** Runs the CDK CLI in a checkout, with the account pinned to the one the role is in. */
  run(root: string, args: readonly string[], env: Env): StepResult {
    const [cmd, ...pre] = this.o.app.cdk;
    const full = [...pre, ...args];
    this.o.log(`${cmd} ${full.join(" ")}`);
    const r = this.o.exec(cmd as string, full, {
      env: { ...env, CDK_DEFAULT_ACCOUNT: this.o.account(), CDK_DEFAULT_REGION: this.o.aws.region },
      cwd: path.join(root, this.o.app.dir),
      stream: true,
    });
    return {
      ok: r.status === 0,
      detail: r.status === 0 ? "cdk exited 0" : `cdk exited ${String(r.status)}`,
    };
  }

  /** The output keys of every stack's synthesized template in a checkout. */
  templateOutputs(root: string): Set<string> {
    const keys = new Set<string>();
    for (const stack of this.o.app.stacks) {
      const file = path.join(root, this.o.app.dir, this.o.app.output, `${stack}.template.json`);
      const template = JSON.parse(fs.readFileSync(file, "utf8")) as {
        Outputs?: Record<string, unknown>;
      };
      for (const k of templateOutputKeys(template)) keys.add(k);
    }
    return keys;
  }

  async synth(settings: Readonly<Record<string, string>>): Promise<SynthResult> {
    const r = this.run(
      this.o.repoRoot,
      cdkArgs(this.o.app, "synth", this.context(settings)),
      this.o.deployEnv(),
    );
    if (!r.ok) return { ...r, outputs: new Set() };
    return { ...r, outputs: this.templateOutputs(this.o.repoRoot) };
  }

  async deploy(settings: Readonly<Record<string, string>>): Promise<StepResult> {
    const env = this.o.deployEnv();
    const monitoring = this.o.monitoringMinutes ?? DEFAULT_MONITORING_MINUTES;
    const wanted = this.o.rollbackTriggers ?? [];
    const alarms = listExistingAlarms(this.o.aws, env, wanted, {
      ...(this.o.alarmPrefix ? { prefix: this.o.alarmPrefix } : {}),
      ...(this.o.now ? { now: this.o.now() } : {}),
    });
    for (const a of alarms) {
      if (a.HistoryError) {
        this.o.log(
          `  could not read the state history of ${a.AlarmName}, so it is a trigger if it is OK: ${a.HistoryError}`,
        );
      }
    }
    const triggers = selectRollbackTriggers(wanted, alarms);
    this.o.log(
      `rollback triggers (CloudFormation rolls the deploy back if one goes to ALARM, for ${monitoring} minutes after it): ${triggers.arns.length === 0 ? "none" : triggers.arns.join(", ")}`,
    );
    for (const l of triggers.left) this.o.log(`  not a trigger: ${l}`);
    return this.run(
      this.o.repoRoot,
      cdkArgs(this.o.app, "deploy", this.context(settings), triggers.arns, monitoring),
      env,
    );
  }

  async rollback(commit: string, settings: Readonly<Record<string, string>>): Promise<StepResult> {
    const { exec, repoRoot } = this.o;
    const dir = path.join(tmpdir(), `rollback-${commit.slice(0, 12)}`);
    const git = (...args: string[]): boolean =>
      exec("git", args, { env: process.env, cwd: repoRoot }).status === 0;
    if (!git("cat-file", "-e", `${commit}^{commit}`)) git("fetch", "origin", commit);
    if (!git("worktree", "add", "--force", "--detach", dir, commit)) {
      return { ok: false, detail: `git could not check out ${commit} (is it in the clone?)` };
    }
    const [cmd, ...args] = this.o.install ?? ["pnpm", "install", "--frozen-lockfile"];
    const install = exec(cmd as string, args, { env: process.env, cwd: dir, stream: true });
    if (install.status !== 0)
      return { ok: false, detail: `the install failed in the checkout of ${commit}` };
    // No rollback triggers: the alarms that caused the rollback are in ALARM, and CloudFormation does not watch them during a rollback.
    return this.run(
      dir,
      cdkArgs(this.o.app, "deploy", this.context(settings, commit)),
      this.o.deployEnv(),
    );
  }
}
