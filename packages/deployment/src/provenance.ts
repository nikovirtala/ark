/**
 * Provenance: where a commit runs, and which commit produced a trace.
 *
 * Each run that passes the freeze flag records a GitHub deployment for the commit and the
 * environment and moves its status: in_progress when it starts, error when it refuses (nothing was
 * deployed), failure when a deploy, smoke check or task fails, success when it succeeds. On success
 * the run marks every earlier deployment of the environment whose newest status is success as
 * inactive: GitHub's own auto_inactive skips production environments
 * (https://docs.github.com/en/rest/deployments/statuses). Descriptions are fixed sentences with the
 * short commit: ids and names only, never what a check printed.
 *
 * The OpenTelemetry resource attributes of a deployed stack come from the same facts, passed to the
 * app as CDK context by the CDK target (cdk/provenance.ts).
 */
import type { DeploymentState, GitHubDeploymentsApi } from "./github.js";
import type { RunProvenance } from "./orchestrate.js";
import type { RunOutcome, RunPhase } from "./records.js";

/** The GitHub status and description for how a run ended. */
export function deploymentStatus(
  outcome: RunOutcome,
  commit: string,
): { state: DeploymentState; description: string } {
  const sha = commit.slice(0, 7);
  switch (outcome) {
    case "succeeded":
      return {
        state: "success",
        description: `Deployed ${sha}: the deploy, the smoke checks and the tasks passed`,
      };
    case "refused":
      return {
        state: "error",
        description: `Refused ${sha}: a setting or a preflight check failed; nothing was deployed`,
      };
    case "check-failed":
      return {
        state: "error",
        description: `Refused ${sha}: it does not synth; nothing was deployed`,
      };
    case "rolled-back":
      return {
        state: "failure",
        description: `Failed ${sha}: rolled back to the last good commit; the pipeline is frozen`,
      };
    case "rollback-failed":
      return {
        state: "failure",
        description: `Failed ${sha}, and so did the rollback; the pipeline is frozen`,
      };
    case "task-failed":
      return {
        state: "failure",
        description: `Deployed ${sha}, but a deployment task failed; not rolled back; frozen`,
      };
    case "frozen":
      return { state: "failure", description: `Not deployed ${sha}: the pipeline is frozen` };
  }
}

export interface GitHubProvenanceOptions {
  readonly api: GitHubDeploymentsApi;
  readonly commit: string;
  readonly environment: string;
  readonly logsUrl: string;
  /** Whether the environment is production for GitHub. Default: its name is `production`. */
  readonly production?: boolean;
  readonly log: (message: string) => void;
}

/** A run's GitHub deployment. Errors are thrown to the run, which logs them and goes on. */
export class GitHubProvenance implements RunProvenance {
  private readonly o: GitHubProvenanceOptions;
  private id: number | undefined;

  constructor(options: GitHubProvenanceOptions) {
    this.o = options;
  }

  async start(): Promise<number | undefined> {
    const { api, commit, environment, logsUrl } = this.o;
    const { id } = await api.createDeployment({
      ref: commit,
      environment,
      description: `Pipeline run for ${commit.slice(0, 7)}`,
      productionEnvironment: this.o.production ?? environment === "production",
    });
    this.id = id;
    await api.createStatus(id, {
      state: "in_progress",
      description: `Deploying ${commit.slice(0, 7)}`,
      logUrl: logsUrl,
      environment,
    });
    this.o.log(`GitHub deployment ${id} for ${commit.slice(0, 7)} in ${environment}: in_progress`);
    return id;
  }

  async finish(result: { phase: RunPhase; outcome: RunOutcome; summary: string }): Promise<void> {
    if (this.id === undefined) return;
    const { api, commit, environment, logsUrl } = this.o;
    const status = deploymentStatus(result.outcome, commit);
    await api.createStatus(this.id, { ...status, logUrl: logsUrl, environment });
    this.o.log(`GitHub deployment ${this.id}: ${status.state}`);
    if (status.state !== "success") return;
    const superseded: number[] = [];
    for (const d of await api.listDeployments(environment)) {
      if (d.id === this.id) continue;
      if ((await api.latestState(d.id)) !== "success") continue;
      await api.createStatus(d.id, {
        state: "inactive",
        description: `Superseded by ${commit.slice(0, 7)}`,
        environment,
      });
      superseded.push(d.id);
    }
    if (superseded.length > 0)
      this.o.log(`GitHub deployments marked inactive: ${superseded.join(", ")}`);
  }
}

/** The facts about a deployed version that its telemetry carries. */
export interface ProvenanceFacts {
  readonly commit: string;
  readonly repositoryUrl: string;
  readonly environment: string;
  /** The service version. Default: the commit. */
  readonly version?: string;
}

/** The OpenTelemetry resource attributes, by their semantic-convention names. */
export function provenanceAttributes(facts: ProvenanceFacts): Record<string, string> {
  return {
    "vcs.ref.head.revision": facts.commit,
    "vcs.repository.url.full": facts.repositoryUrl,
    "deployment.environment.name": facts.environment,
    "service.version": facts.version ?? facts.commit,
  };
}

/**
 * The attributes as the value of `OTEL_RESOURCE_ATTRIBUTES`: `key=value` pairs separated by commas,
 * with `,`, `=`, `%` and spaces in a value percent-encoded, as the OpenTelemetry SDKs read it.
 */
export function otelResourceAttributes(attributes: Readonly<Record<string, string>>): string {
  const enc = (v: string): string =>
    v.replace(/[%,= ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return Object.entries(attributes)
    .map(([k, v]) => `${k}=${enc(v)}`)
    .join(",");
}

/** The repository URL of `owner/repo` on GitHub. */
export function githubRepositoryUrl(repository: string): string {
  return `https://github.com/${repository}`;
}
