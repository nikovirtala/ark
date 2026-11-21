/**
 * The read side of a deployment, as library functions the CLI prints and the read-only MCP server
 * will serve (deploy_status, deploy_run, deploy_environments, deploy_simulate): none of them changes
 * anything.
 */
import type { DeploymentConfig } from "./config.js";
import type { Freeze, FreezeState } from "./freeze.js";
import type { LedgerStore } from "./ledger.js";
import type { LastGood, RunRecord } from "./records.js";
import { type ResolvedSettings, resolveSettings, type Values } from "./settings.js";
import type { TaskFile } from "./tasks/discover.js";
import { listTasks, type TaskListing } from "./tasks/listing.js";

export const STATUS_SCHEMA = "deployment-status/v1";

export interface StatusReport {
  readonly schema: typeof STATUS_SCHEMA;
  readonly project: string;
  readonly environment: string;
  readonly freeze: FreezeState;
  /** null, not undefined, so a JSON reader sees the key. */
  readonly lastGood: LastGood | null;
  readonly runs: readonly RunRecord[];
  readonly tasks: readonly TaskListing[];
}

export interface StatusSources {
  readonly project: string;
  readonly environment: string;
  readonly freeze: Freeze;
  readonly ledger: LedgerStore;
  readonly tasks: readonly TaskFile[];
  readonly runs?: number;
}

/** Frozen or not, the last good commit, the newest runs and every task with its state. */
export async function deploymentStatus(s: StatusSources): Promise<StatusReport> {
  const [freeze, lastGood, runs, tasks] = await Promise.all([
    s.freeze.read(),
    s.ledger.lastGood(),
    // DynamoDB refuses a Limit of 0: ask for no runs by not asking.
    (s.runs ?? 5) > 0 ? s.ledger.recentRuns(s.runs ?? 5) : Promise.resolve([]),
    listTasks(s.tasks, s.ledger),
  ]);
  return {
    schema: STATUS_SCHEMA,
    project: s.project,
    environment: s.environment,
    freeze,
    lastGood: lastGood ?? null,
    runs,
    tasks,
  };
}

/** One run's record, by its time (`RUN#<at>`) or its execution id, among the newest `limit`. */
export async function findRun(
  ledger: LedgerStore,
  key: string,
  limit = 100,
): Promise<RunRecord | undefined> {
  return (await ledger.recentRuns(limit)).find((r) => r.at === key || r.execution === key);
}

export interface EnvironmentInfo {
  readonly name: string;
  readonly region: string;
  readonly ledgerTable: string;
  readonly freezeParameter: string;
  readonly settingsPrefix: string;
  readonly stacks: readonly string[];
}

/** The environments a config deploys: one per `deploy.toml` for now. */
export function environments(config: DeploymentConfig): EnvironmentInfo[] {
  const r = config.raw;
  return [
    {
      name: r.project.environment,
      region: r.project.region,
      ledgerTable: r.ledger.table,
      freezeParameter: r.freeze.parameter,
      settingsPrefix: r.settings.prefix,
      stacks: r.target.stacks,
    },
  ];
}

export const PLAN_SCHEMA = "deployment-plan/v1";

/** What a run would do now, without doing any of it (`deploy dry-run`, later `deploy_simulate`). */
export interface RunPlan {
  readonly schema: typeof PLAN_SCHEMA;
  /** Whether a run would get past the freeze flag and the settings. */
  readonly wouldDeploy: boolean;
  readonly freeze: FreezeState;
  readonly settings: ResolvedSettings;
  /** The tasks a run would dry-run and run, in order. */
  readonly pendingTasks: readonly string[];
  readonly lastGood: LastGood | null;
  /** Why a run would stop before deploying, one line each. */
  readonly stops: readonly string[];
}

export async function planRun(s: {
  readonly config: DeploymentConfig;
  readonly freeze: Freeze;
  readonly ledger: LedgerStore;
  readonly tasks: readonly TaskFile[];
  readonly storedSettings: () => Promise<Values>;
}): Promise<RunPlan> {
  const freeze = await s.freeze.read();
  const settings = resolveSettings(s.config.specs, await s.storedSettings());
  const done = await s.ledger.doneIds();
  const stops: string[] = [];
  if (freeze.frozen) stops.push("the freeze flag is set: the run would stop at once");
  for (const e of settings.errors) stops.push(`the run would refuse: ${e}`);
  return {
    schema: PLAN_SCHEMA,
    wouldDeploy: stops.length === 0,
    freeze,
    settings,
    pendingTasks: s.tasks.filter((t) => !done.has(t.id)).map((t) => t.id),
    lastGood: (await s.ledger.lastGood()) ?? null,
    stops,
  };
}
