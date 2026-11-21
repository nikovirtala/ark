/**
 * The `deploy` commands, for the pipeline's build and for a person's machine:
 *
 *   deploy status                        frozen or not, the last good commit, the last runs, the tasks
 *   deploy settings [--env-file F]       copy deploy.env's settings into SSM (default F: <root>/deploy.env)
 *   deploy freeze "<reason>"             freeze by hand
 *   deploy unfreeze                      clear the freeze flag
 *   deploy tasks [--check]               the tasks and which are in the ledger (--check: validate each)
 *   deploy dry-run                       what a run would do now; changes nothing
 *   deploy dry-run <task>                one task's dry run, with YOUR credentials
 *   deploy run                           one pipeline run (the build's main step)
 *   deploy run <task>                    one task by hand: dry run first, recorded in the ledger
 *   deploy forget <task>                 put a done task back to pending
 *
 * Global flags: --json, --config <deploy.toml>. Exit 0 on success, 1 on a failed or refused run or
 * task, 2 when the command cannot run (usage, config). Agents read, people act: with ARK_AGENT set,
 * run, unfreeze, forget and settings refuse (exit 2).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Aws, defaultExec, type Env, type Exec } from "../aws.js";
import { ConfigError, type DeploymentConfig, loadConfig } from "../config.js";
import { frozenMessage } from "../freeze.js";
import { orchestrate } from "../orchestrate.js";
import { parseEnvFile, publishSettings, readSettings } from "../settings.js";
import { deploymentStatus, planRun } from "../status.js";
import { validateTask } from "../tasks/listing.js";
import { runTasks } from "../tasks/runner.js";
import {
  buildSteps,
  type Clients,
  executorFor,
  makeClients,
  provenanceFor,
  rolePolicy,
  runContext,
  tasksOf,
} from "../wiring.js";

export interface CliIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface CliDeps {
  readonly env?: Env;
  readonly cwd?: string;
  readonly exec?: Exec;
  /** For tests: the clients instead of the SDK's. */
  readonly clients?: (config: DeploymentConfig) => Clients;
  readonly aws?: (config: DeploymentConfig) => Aws;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const PEOPLE_ONLY = new Set(["run", "unfreeze", "forget", "settings"]);

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface Parsed {
  readonly command: string | undefined;
  readonly args: string[];
  readonly json: boolean;
  readonly config: string | undefined;
  readonly envFile: string | undefined;
  readonly check: boolean;
}

function parse(argv: readonly string[]): Parsed {
  const args: string[] = [];
  let json = false;
  let config: string | undefined;
  let envFile: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") json = true;
    else if (a === "--check") check = true;
    else if (a === "--config" || a === "--env-file") {
      const v = argv[++i];
      if (!v) throw new UsageError(`${a} needs a value`);
      if (a === "--config") config = v;
      else envFile = v;
    } else if (a.startsWith("--")) throw new UsageError(`unknown flag ${a}`);
    else args.push(a);
  }
  const [command, ...rest] = args;
  return { command, args: rest, json, config, envFile, check };
}

export const USAGE = `usage: deploy <command> [--json] [--config deploy.toml]
  status                  frozen or not, the last good commit, the last runs, the tasks
  settings [--env-file F] copy deploy.env's settings into SSM
  freeze "<reason>"       stop merges from deploying
  unfreeze                clear the freeze flag (after fixing what froze it)
  tasks [--check]         the deployment tasks and which are done
  dry-run [<task>]        what a run would do now, or one task's dry run
  run [<task>]            one pipeline run (the build's step), or one task by hand
  forget <task>           put a done task back to pending`;

/** Runs one command. Returns the exit code; never exits the process. */
export async function runDeployCli(
  argv: readonly string[],
  io: CliIO,
  deps: CliDeps = {},
): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (err) {
    io.err(`deploy: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!p.command || p.command === "help") {
    (p.command ? io.out : io.err)(USAGE);
    return p.command ? 0 : 2;
  }
  const env = deps.env ?? process.env;
  if (env.ARK_AGENT && PEOPLE_ONLY.has(p.command)) {
    io.err(
      `deploy: ${p.command} is for people. Agents read deployments (status, tasks, dry-run) and never deploy, unfreeze or forget; ask the person you work for to run: deploy ${[p.command, ...p.args].join(" ")}`,
    );
    return 2;
  }
  let config: DeploymentConfig;
  try {
    config = loadConfig(p.config, deps.cwd ?? process.cwd());
  } catch (err) {
    io.err(`deploy: ${(err as Error).message}`);
    return 2;
  }
  const exec = deps.exec ?? defaultExec;
  const aws = deps.aws ? deps.aws(config) : new Aws(config.project.region, exec, env);
  const clients = deps.clients ? deps.clients(config) : makeClients(config);
  const now = deps.now ?? (() => new Date());
  const print = (text: string, doc?: unknown): void =>
    io.out(p.json && doc !== undefined ? JSON.stringify(doc, null, 2) : text);
  const hint = config.hints.unfreeze;

  try {
    switch (p.command) {
      case "status": {
        const s = await deploymentStatus({
          project: config.project.name,
          environment: config.project.environment,
          freeze: clients.freeze,
          ledger: clients.ledger,
          tasks: tasksOf(config),
        });
        const lines = [
          `${config.project.name} (${config.project.environment}, ${config.project.region})`,
          s.freeze.frozen ? frozenMessage(s.freeze, hint) : "Not frozen: merges to main deploy.",
          `Last good commit: ${s.lastGood ? `${s.lastGood.commit} (${s.lastGood.at}, execution ${s.lastGood.execution})` : "none yet"}`,
          ...s.runs.map(
            (r) =>
              `  ${r.at}  ${r.outcome.padEnd(15)} ${r.commit.slice(0, 10)}  ${r.summary.slice(0, 140)}`,
          ),
          `Deployment tasks: ${s.tasks.length === 0 ? `none in ${config.raw.tasks.dir}/` : s.tasks.map((t) => `${t.id} (${t.state}${t.file ? "" : ", file deleted"})`).join(", ")}`,
        ];
        print(lines.join("\n"), s);
        return 0;
      }
      case "freeze": {
        const reason = p.args.join(" ").trim();
        if (!reason) throw new UsageError('say why: deploy freeze "<reason>"');
        await clients.freeze.set({
          reason: `by hand: ${reason}`,
          commit: "-",
          at: now().toISOString(),
          logs: "-",
          by: "person",
        });
        print(`Frozen. Merges to main deploy nothing until: ${hint}`, { ok: true, frozen: true });
        return 0;
      }
      case "unfreeze": {
        const was = await clients.freeze.clear();
        print(was ? "Unfrozen: the next merge to main deploys." : "It was not frozen.", {
          ok: true,
          wasFrozen: was,
        });
        return 0;
      }
      case "settings": {
        const file = path.resolve(p.envFile ?? path.join(config.root, "deploy.env"));
        const result = await publishSettings(
          clients.ssm,
          config.raw.settings.prefix,
          config.specs,
          parseEnvFile(fs.readFileSync(file, "utf8")),
        );
        print(
          [
            `Copied ${result.written.length} setting(s) from ${file} to SSM: ${result.written.join(", ")}`,
            ...(result.removed.length > 0
              ? [`Removed from SSM (no longer in the file): ${result.removed.join(", ")}`]
              : []),
          ].join("\n"),
          result,
        );
        return 0;
      }
      case "tasks": {
        const tasks = tasksOf(config);
        const s = await deploymentStatus({
          project: config.project.name,
          environment: config.project.environment,
          freeze: clients.freeze,
          ledger: clients.ledger,
          tasks,
          runs: 0,
        });
        const checks = p.check
          ? await Promise.all(
              tasks.map((t) =>
                validateTask(
                  t.file,
                  fs.statSync(t.file).mode,
                  executorFor(config, exec, env),
                  rolePolicy(config),
                  { interpreters: config.raw.tasks.interpreters },
                ),
              ),
            )
          : [];
        const lines = s.tasks.map((t) => {
          const v = checks.find((c) => c.id === t.id);
          const check = v
            ? v.ok
              ? `  ok: ${v.needs?.role}: ${v.needs?.description}`
              : `  INVALID: ${v.problems.join("; ")}`
            : "";
          return `${t.state === "done" ? "done   " : "pending"} ${t.id}${t.file ? "" : " (its file is deleted)"}${check}`;
        });
        print(
          lines.length > 0 ? lines.join("\n") : `no deployment tasks in ${config.raw.tasks.dir}/`,
          { tasks: s.tasks, checks },
        );
        return checks.some((c) => !c.ok) ? 1 : 0;
      }
      case "forget": {
        const id = p.args[0];
        if (!id) throw new UsageError("forget needs a task id (see: deploy tasks)");
        const forgotten = await clients.ledger.forget(id, now().toISOString());
        print(forgotten ? `${id} is pending again.` : `${id} was not in the ledger.`, {
          ok: true,
          forgotten,
        });
        return 0;
      }
      case "dry-run":
      case "run": {
        const id = p.args[0];
        if (id) return await oneTask(p.command, id);
        if (p.command === "dry-run") {
          const plan = await planRun({
            config,
            freeze: clients.freeze,
            ledger: clients.ledger,
            tasks: tasksOf(config),
            storedSettings: () => readSettings(clients.ssm, config.raw.settings.prefix),
          });
          const lines = [
            plan.freeze.frozen ? frozenMessage(plan.freeze, hint) : "Not frozen.",
            `Settings: ${Object.keys(plan.settings.values).length} set${plan.settings.errors.length > 0 ? `, ${plan.settings.errors.length} problem(s):\n  ${plan.settings.errors.join("\n  ")}` : ", none missing"}`,
            `Pending deployment tasks: ${plan.pendingTasks.length === 0 ? "none" : plan.pendingTasks.join(", ")}`,
            `Last good commit: ${plan.lastGood?.commit ?? "none yet"}`,
            plan.wouldDeploy
              ? "A run now would deploy (after the checks, the synth and the preflight)."
              : `A run now would not deploy:\n  ${plan.stops.join("\n  ")}`,
          ];
          print(lines.join("\n"), plan);
          return plan.wouldDeploy ? 0 : 1;
        }
        const ctx = runContext(config, env, (m) => io.out(m));
        ctx.log(`pipeline run for commit ${ctx.commit} (execution ${ctx.execution})`);
        const result = await orchestrate({
          ctx,
          freeze: clients.freeze,
          ledger: clients.ledger,
          steps: buildSteps({ config, ctx, clients, exec, aws }),
          ...(await provenanceOrNothing(ctx)),
        });
        ctx.log(`RESULT: ${result.outcome}: ${result.summary}`);
        if (p.json) io.out(JSON.stringify(result, null, 2));
        return result.exitCode;
      }
      default:
        throw new UsageError(`unknown command: ${p.command}`);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      io.err(`deploy: ${err.message}${err instanceof UsageError ? `\n${USAGE}` : ""}`);
      return 2;
    }
    io.err(`ERROR: ${(err as Error).message}`);
    return 1;
  }

  async function provenanceOrNothing(ctx: ReturnType<typeof runContext>) {
    // Only past the freeze flag does a run record a deployment, and orchestrate() decides that; the
    // token is read here, before it, so a frozen run reads it for nothing but stays cheap.
    const state = await clients.freeze.read();
    if (state.frozen) return {};
    const provenance = provenanceFor(config, ctx, aws, deps.fetch ?? fetch);
    return provenance ? { provenance } : {};
  }

  async function oneTask(mode: "dry-run" | "run", id: string): Promise<number> {
    const commit =
      env.GIT_COMMIT ??
      (exec("git", ["rev-parse", "HEAD"], { env, cwd: config.root }).stdout.trim() || "unknown");
    const report = await runTasks({
      tasks: tasksOf(config),
      only: id,
      dryRunOnly: mode === "dry-run",
      ledger: clients.ledger,
      executor: executorFor(config, exec, env),
      policy: rolePolicy(config),
      commit,
      now,
      log: (m) => io.out(m),
      // By hand there is no runner role to assume from: the task runs with the credentials of whoever started it.
      credentialsFor: () => env,
      outputsFor: async (names) => {
        if (names.length === 0) return {};
        const all = aws.stackOutputs(config.outputsStack);
        return Object.fromEntries(names.map((n) => [n, all[n] ?? ""]));
      },
      aws: (a, e) => aws.json(a, e),
      region: config.project.region,
    });
    if (report.skipped.length > 0)
      io.out(
        `${id} is already in the ledger: it does not run again (deploy forget ${id} puts it back).`,
      );
    if (p.json) io.out(JSON.stringify(report, null, 2));
    return report.failed ? 1 : 0;
  }
}
