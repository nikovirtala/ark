/**
 * The real steps of a pipeline run, from a project's `deploy.toml`: the AWS CLI, the CDK target, the
 * smoke stage, the task runner and the roles of the project's pipeline stack. `orchestrate.ts`
 * decides; this file does. It needs the build environment (or a person's machine), so it is exercised
 * by a project's first run, and its seams by unit tests with a fake `Exec`.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type Aws, type Env, type Exec, tail, withoutCredentials } from "./aws.js";
import { CdkTarget } from "./cdk/target.js";
import { type DeploymentConfig, logsUrl, type PreflightCheck } from "./config.js";
import { FreezeStore, type SsmPort } from "./freeze.js";
import { githubRestApi } from "./github.js";
import { Ledger } from "./ledger.js";
import type { RunContext, RunProvenance, Steps } from "./orchestrate.js";
import { GitHubProvenance, githubRepositoryUrl } from "./provenance.js";
import { readSettings, resolveSettings } from "./settings.js";
import { runSmokeStage } from "./smoke/stage.js";
import { deletable, discoverTasks, type TaskFile } from "./tasks/discover.js";
import { ProcessExecutor } from "./tasks/protocol.js";
import { type RolePolicy, runTasks } from "./tasks/runner.js";

export interface Clients {
  readonly ssm: SsmPort;
  readonly freeze: FreezeStore;
  readonly ledger: Ledger;
}

/** The SDK clients of the ledger and the freeze flag. `AWS_ENDPOINT_URL` points them elsewhere (the AWS Emulator). */
export function makeClients(config: DeploymentConfig): Clients {
  const region = config.project.region;
  const ssm = new SSMClient({ region });
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    ssm,
    freeze: new FreezeStore(ssm, config.raw.freeze.parameter, config.hints.unfreeze),
    ledger: new Ledger(documents, {
      table: config.raw.ledger.table,
      taskKeyPrefix: config.raw.ledger.task_key_prefix,
    }),
  };
}

export function rolePolicy(config: DeploymentConfig): RolePolicy {
  return { taskRolePrefix: config.raw.roles.task_prefix, forbidden: [config.raw.roles.deploy] };
}

export function tasksOf(config: DeploymentConfig): TaskFile[] {
  return discoverTasks(config.tasksDir, { interpreters: config.raw.tasks.interpreters });
}

export function executorFor(config: DeploymentConfig, exec: Exec, baseEnv: Env): ProcessExecutor {
  return new ProcessExecutor({
    exec,
    cwd: config.root,
    baseEnv,
    interpreters: config.raw.tasks.interpreters,
    ...(config.raw.tasks.env ? { envNames: config.raw.tasks.env } : {}),
  });
}

/** The context of a run in CodeBuild: the commit and the execution id come from the pipeline's variables. */
export function runContext(
  config: DeploymentConfig,
  env: Env,
  log: (m: string) => void = (m) => console.log(m),
): RunContext {
  const commit = env.COMMIT_ID || env.CODEBUILD_RESOLVED_SOURCE_VERSION;
  if (!commit) throw new Error("no commit: COMMIT_ID (the source action's CommitId) is not set");
  const execution = env.EXECUTION_ID || env.CODEBUILD_BUILD_NUMBER || "manual";
  return {
    project: config.project.name,
    environment: config.project.environment,
    commit,
    execution,
    logsUrl: logsUrl(config, execution),
    now: () => new Date(),
    log,
    hints: config.hints,
  };
}

/** Runs one preflight check as the deploy role. Returns the error line, or undefined when it passes. */
export function preflightCheck(
  check: PreflightCheck,
  settings: Readonly<Record<string, string>>,
  aws: Aws,
  exec: Exec,
  env: Env,
  root: string,
): string | undefined {
  const value = (c: {
    setting?: string | undefined;
    name?: string | undefined;
  }): string | undefined =>
    // The setting's value, else the name the entry gives (the default the deploy script checks).
    (c.setting !== undefined ? settings[c.setting] : undefined) ?? c.name;
  try {
    switch (check.kind) {
      case "secret": {
        const id = value(check);
        if (id === undefined) return undefined; // an optional setting that is not set: nothing to check
        aws.json(["secretsmanager", "describe-secret", "--secret-id", id, "--query", "Name"], env);
        return undefined;
      }
      case "bucket": {
        const bucket = value(check);
        if (bucket === undefined) return undefined;
        aws.json(["s3api", "head-bucket", "--bucket", bucket], env);
        return undefined;
      }
      case "stack": {
        aws.json(
          [
            "cloudformation",
            "describe-stacks",
            "--stack-name",
            check.name,
            "--query",
            "Stacks[0].StackStatus",
          ],
          env,
        );
        return undefined;
      }
      case "command": {
        const [cmd, ...args] = check.argv;
        const r = exec(cmd as string, args, { env, cwd: root });
        return r.status === 0 ? undefined : `${check.why}: ${tail(r.stdout + r.stderr)}`;
      }
    }
  } catch (err) {
    const what =
      check.kind === "secret"
        ? `the secret ${value(check)} does not exist in ${aws.region} (or the deploy role may not describe it)`
        : check.kind === "bucket"
          ? `the bucket ${value(check)} does not exist (or the deploy role may not reach it)`
          : check.kind === "stack"
            ? `the stack ${check.name} does not exist in ${aws.region} (a deploy would create a second one)`
            : check.why;
    return `${what}: ${(err as Error).message}`;
  }
}

export interface WiringOptions {
  readonly config: DeploymentConfig;
  readonly ctx: RunContext;
  readonly clients: Clients;
  readonly exec: Exec;
  readonly aws: Aws;
}

export function buildSteps(opts: WiringOptions): Steps {
  const { config, ctx, clients, exec, aws } = opts;
  const r = config.raw;
  const log = ctx.log;
  const root = config.root;
  const account = (): string => aws.accountId();
  // A role session lasts at most an hour when one role assumes another, so each long step assumes its own.
  const assume = (key: string, purpose: string): Env => {
    const role = r.roles[key];
    if (!role) throw new Error(`no role ${key} in [roles]`);
    return aws.assume(role, `${purpose}-${ctx.execution}`);
  };
  const deployEnv = (): Env => assume("deploy", "deploy");
  const target = new CdkTarget({
    app: {
      cdk: r.target.cdk,
      dir: r.target.dir,
      ...(r.target.app ? { app: r.target.app } : {}),
      output: r.target.output,
      stacks: r.target.stacks,
    },
    exec,
    aws,
    repoRoot: root,
    specs: config.specs,
    provenance: {
      commit: ctx.commit,
      repositoryUrl: githubRepositoryUrl(r.project.repository),
      environment: r.project.environment,
    },
    deployEnv,
    account,
    log,
    rollbackTriggers: r.target.rollback_triggers,
    ...(r.target.alarm_prefix ? { alarmPrefix: r.target.alarm_prefix } : {}),
    monitoringMinutes: Number(process.env.MONITORING_MINUTES ?? r.target.monitoring_minutes),
    install: r.target.install,
  });

  return {
    async settings() {
      return resolveSettings(config.specs, await readSettings(clients.ssm, r.settings.prefix));
    },
    async preflight(settings) {
      if (r.preflight.length === 0) return [];
      const env = deployEnv();
      return r.preflight.flatMap((c) => preflightCheck(c, settings, aws, exec, env, root) ?? []);
    },
    synth: (settings) => target.synth(settings),
    deploy: (settings) => target.deploy(settings),
    rollback: (commit, settings) => target.rollback(commit, settings),
    async smoke(templateOutputs) {
      const envs = new Map<string, Env>();
      return runSmokeStage({
        exec,
        repoRoot: root,
        checks: r.smoke.command,
        before: config.smokeBefore,
        after: config.smokeAfter,
        markers: r.smoke.markers,
        templateOutputs,
        // A check can then compare what it finds with what was deployed (the provenance it stamped).
        checksEnv: { DEPLOY_COMMIT: ctx.commit, DEPLOY_ENVIRONMENT: r.project.environment },
        envFor: (key) => {
          if (!envs.has(key)) envs.set(key, assume(key, key));
          return envs.get(key) as Env;
        },
        log,
      });
    },
    async tasks() {
      const smokeEnv = assume("smoke", "outputs");
      return runTasks({
        tasks: tasksOf(config),
        ledger: clients.ledger,
        executor: executorFor(config, exec, withoutCredentials(process.env)),
        policy: rolePolicy(config),
        commit: ctx.commit,
        now: ctx.now,
        log,
        credentialsFor: (role, session) => aws.assume(role, session),
        outputsFor: async (names) => {
          if (names.length === 0) return {};
          const all = aws.stackOutputs(config.outputsStack, smokeEnv);
          const missing = names.filter((n) => all[n] === undefined);
          if (missing.length > 0)
            throw new Error(`the stack ${config.outputsStack} has no output ${missing.join(", ")}`);
          return Object.fromEntries(names.map((n) => [n, all[n] as string]));
        },
        aws: (args, env) => aws.json(args, env),
        region: aws.region,
      });
    },
    async deletable() {
      return deletable(tasksOf(config), await clients.ledger.doneIds(), root);
    },
    async notify(subject, message) {
      const topic = r.notify.topic;
      if (!topic) {
        log(`no [notify] topic: not published: ${subject}`);
        return;
      }
      const arn = `arn:aws:sns:${aws.region}:${account()}:${topic}`;
      aws.json([
        "sns",
        "publish",
        "--topic-arn",
        arn,
        "--subject",
        subject.replace(/[^\x20-\x7e]/g, " ").slice(0, 99),
        "--message",
        message.slice(0, 20000),
      ]);
    },
  };
}

/** The run's GitHub deployment, when the project names a token secret. Undefined (and said so) otherwise. */
export function provenanceFor(
  config: DeploymentConfig,
  ctx: RunContext,
  aws: Aws,
  fetchImpl: typeof fetch = fetch,
): RunProvenance | undefined {
  const secret = config.raw.provenance.github_token_secret;
  if (!secret) {
    ctx.log("no [provenance] github_token_secret: no GitHub deployment is recorded");
    return undefined;
  }
  let token: string;
  try {
    token = String(
      aws.json([
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        secret,
        "--query",
        "SecretString",
      ]),
    ).trim();
  } catch (err) {
    ctx.log(
      `could not read the GitHub token (${secret}): no GitHub deployment is recorded: ${(err as Error).message}`,
    );
    return undefined;
  }
  return new GitHubProvenance({
    api: githubRestApi({ repository: config.project.repository, token, fetch: fetchImpl }),
    commit: ctx.commit,
    environment: config.project.environment,
    logsUrl: ctx.logsUrl,
    ...(config.raw.provenance.production !== undefined
      ? { production: config.raw.provenance.production }
      : {}),
    log: ctx.log,
  });
}
