/**
 * The part of GitHub's REST API a run uses: deployments and their statuses
 * (https://docs.github.com/en/rest/deployments). A port, so tests use a fake server and the run never
 * depends on GitHub being up.
 */

export type DeploymentState =
  | "error"
  | "failure"
  | "inactive"
  | "in_progress"
  | "queued"
  | "pending"
  | "success";

export interface CreateDeploymentInput {
  readonly ref: string;
  readonly environment: string;
  readonly description: string;
  readonly productionEnvironment: boolean;
}

export interface CreateStatusInput {
  readonly state: DeploymentState;
  readonly description: string;
  readonly logUrl?: string;
  readonly environment: string;
}

export interface GitHubDeployment {
  readonly id: number;
  readonly sha: string;
  readonly environment: string;
}

export interface GitHubDeploymentsApi {
  createDeployment(input: CreateDeploymentInput): Promise<{ id: number }>;
  createStatus(id: number, input: CreateStatusInput): Promise<void>;
  /** The newest deployments of an environment first (one page of up to 100). */
  listDeployments(environment: string): Promise<GitHubDeployment[]>;
  /** The state of a deployment's newest status, or undefined when it has none. */
  latestState(id: number): Promise<DeploymentState | undefined>;
}

export interface GitHubRestOptions {
  /** `owner/repo`. */
  readonly repository: string;
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/** GitHub's REST API over fetch, with a token that may write deployments. */
export function githubRestApi(options: GitHubRestOptions): GitHubDeploymentsApi {
  const base = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const f = options.fetch ?? fetch;
  const repo = `${base}/repos/${options.repository}`;
  const call = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    const res = await f(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      // The message only: GitHub's error bodies carry no token, and the rest is noise in the log.
      let message = "";
      try {
        message = String(((await res.json()) as { message?: unknown }).message ?? "");
      } catch {
        // not JSON
      }
      throw new Error(
        `GitHub ${method} ${url.slice(base.length)}: ${res.status}${message ? ` ${message}` : ""}`,
      );
    }
    return res.status === 204 ? undefined : res.json();
  };
  return {
    async createDeployment(input) {
      const out = (await call("POST", `${repo}/deployments`, {
        ref: input.ref,
        environment: input.environment,
        description: input.description,
        // The pipeline ran its own checks; a commit status GitHub waits for must not block the record.
        required_contexts: [],
        auto_merge: false,
        production_environment: input.productionEnvironment,
        transient_environment: false,
      })) as { id?: unknown };
      if (typeof out?.id !== "number") throw new Error("GitHub created no deployment id");
      return { id: out.id };
    },
    async createStatus(id, input) {
      await call("POST", `${repo}/deployments/${id}/statuses`, {
        state: input.state,
        description: input.description,
        environment: input.environment,
        ...(input.logUrl ? { log_url: input.logUrl } : {}),
        // GitHub does not mark production deployments inactive by itself; the run does (provenance.ts).
        auto_inactive: false,
      });
    },
    async listDeployments(environment) {
      const out = (await call(
        "GET",
        `${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
      )) as Array<{ id: number; sha: string; environment: string }>;
      return out.map((d) => ({ id: d.id, sha: d.sha, environment: d.environment }));
    },
    async latestState(id) {
      const out = (await call("GET", `${repo}/deployments/${id}/statuses?per_page=1`)) as Array<{
        state: DeploymentState;
      }>;
      return out[0]?.state;
    },
  };
}
