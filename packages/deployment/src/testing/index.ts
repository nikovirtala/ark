/**
 * `@nikovirtala/deployment/testing`: in-memory stand-ins for the freeze flag, the ledger and GitHub's
 * deployments, with the same methods as the real ones, so a project tests its tasks and its wiring
 * without AWS or GitHub. The real ones are tested on the AWS Emulator and a fake GitHub server.
 */
import type { Freeze, FreezeInput, FreezeState } from "../freeze.js";
import type {
  CreateDeploymentInput,
  CreateStatusInput,
  DeploymentState,
  GitHubDeployment,
  GitHubDeploymentsApi,
} from "../github.js";
import type { LedgerStore, RunInput } from "../ledger.js";
import {
  FREEZE_SCHEMA,
  type FreezeRecord,
  type LastGood,
  phaseOf,
  RUN_SCHEMA,
  type RunRecord,
  type TaskRecord,
} from "../records.js";

export class MemoryFreeze implements Freeze {
  record: FreezeRecord | undefined;
  /** What `read` answers when the flag cannot be read at all (a permissions mistake). */
  unreadable = false;
  sets: FreezeRecord[] = [];
  clears = 0;
  failSet = false;

  async read(): Promise<FreezeState> {
    if (this.unreadable) {
      return {
        frozen: true,
        record: undefined,
        note: "the flag could not be read (AccessDeniedException): treated as frozen",
      };
    }
    return this.record ? { frozen: true, record: this.record } : { frozen: false };
  }

  async set(input: FreezeInput): Promise<void> {
    if (this.failSet) throw new Error("ssm is down");
    this.record = { schema: FREEZE_SCHEMA, ...input };
    this.sets.push(this.record);
  }

  async clear(): Promise<boolean> {
    const had = this.record !== undefined;
    this.record = undefined;
    this.clears++;
    return had;
  }
}

export class MemoryLedger implements LedgerStore {
  done = new Map<string, TaskRecord>();
  attemptsLog: TaskRecord[] = [];
  good: LastGood | undefined;
  runs: RunRecord[] = [];

  async doneIds(): Promise<Set<string>> {
    return new Set(this.done.keys());
  }
  async getDone(id: string): Promise<TaskRecord | undefined> {
    return this.done.get(id);
  }
  async recordAttempt(rec: TaskRecord): Promise<void> {
    this.attemptsLog.push(rec);
  }
  async markDone(rec: TaskRecord): Promise<void> {
    if (this.done.has(rec.id)) {
      throw Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
      });
    }
    this.done.set(rec.id, rec);
  }
  async attempts(id: string): Promise<TaskRecord[]> {
    return this.attemptsLog.filter((a) => a.id === id);
  }
  async forget(id: string): Promise<boolean> {
    return this.done.delete(id);
  }
  async lastGood(): Promise<LastGood | undefined> {
    return this.good;
  }
  async setLastGood(good: LastGood): Promise<void> {
    this.good = good;
  }
  async recordRun(rec: RunInput): Promise<void> {
    this.runs.push({ schema: RUN_SCHEMA, ...rec, phase: phaseOf(rec.outcome) });
  }
  async recentRuns(limit = 5): Promise<RunRecord[]> {
    return [...this.runs].reverse().slice(0, limit);
  }
}

/** GitHub's deployments in memory: what was created, every status, newest last. */
export class MemoryGitHub implements GitHubDeploymentsApi {
  deployments: Array<GitHubDeployment & { description: string; production: boolean }> = [];
  statuses: Array<{ id: number } & CreateStatusInput> = [];
  private next = 1;

  async createDeployment(input: CreateDeploymentInput): Promise<{ id: number }> {
    const id = this.next++;
    this.deployments.push({
      id,
      sha: input.ref,
      environment: input.environment,
      description: input.description,
      production: input.productionEnvironment,
    });
    return { id };
  }
  async createStatus(id: number, input: CreateStatusInput): Promise<void> {
    if (!this.deployments.some((d) => d.id === id)) throw new Error(`GitHub: no deployment ${id}`);
    this.statuses.push({ id, ...input });
  }
  async listDeployments(environment: string): Promise<GitHubDeployment[]> {
    return this.deployments
      .filter((d) => d.environment === environment)
      .reverse()
      .map(({ id, sha, environment: e }) => ({ id, sha, environment: e }));
  }
  async latestState(id: number): Promise<DeploymentState | undefined> {
    return this.statuses.filter((s) => s.id === id).at(-1)?.state;
  }
  /** The newest state of every deployment, by id. */
  states(): Record<number, DeploymentState | undefined> {
    return Object.fromEntries(
      this.deployments.map((d) => [d.id, this.statuses.filter((s) => s.id === d.id).at(-1)?.state]),
    );
  }
}
