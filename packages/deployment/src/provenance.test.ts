/**
 * Provenance against a fake GitHub API over HTTP: each run records a deployment for its commit and
 * environment and moves its status; a success marks the earlier successful deployments inactive; a
 * GitHub that is down never stops a run; descriptions hold names and the short commit only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { githubRestApi } from "./github.js";
import { deploymentStatus, GitHubProvenance } from "./provenance.js";
import type { RunOutcome } from "./records.js";
import { type FakeGitHub, startFakeGitHub } from "./test-support/fake-github.js";
import { COMMIT, harness, run } from "./test-support/harness.js";

const REPO = "nikovirtala/kiro-remote";
const TOKEN = "ghp_test_token";

describe("GitHub deployments of the runs", () => {
  let gh: FakeGitHub;
  beforeAll(async () => {
    gh = await startFakeGitHub(REPO, TOKEN);
  });
  afterAll(async () => {
    await gh.close();
  });
  beforeEach(() => {
    gh.deployments.length = 0;
    gh.statuses.length = 0;
    gh.requests.length = 0;
    gh.failWith = undefined;
  });

  const provenanceFor = (commit: string, logs: string[] = []) =>
    new GitHubProvenance({
      api: githubRestApi({ repository: REPO, token: TOKEN, baseUrl: gh.url }),
      commit,
      environment: "production",
      logsUrl: "https://console/run",
      log: (m) => void logs.push(m),
    });

  async function deploy(commit: string, over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over, { commit, project: "kiro-remote", environment: "production" });
    h.provenance = provenanceFor(commit, h.logs);
    return { h, result: await run(h) };
  }

  it("records a successful run as a production deployment of its commit, in progress and then success", async () => {
    const { result } = await deploy(COMMIT);
    expect(gh.deployments).toEqual([
      expect.objectContaining({
        sha: COMMIT,
        environment: "production",
        production_environment: true,
        required_contexts: [],
        auto_merge: false,
      }),
    ]);
    const id = gh.deployments[0]?.id as number;
    expect(gh.statuses.filter((s) => s.deployment === id).map((s) => s.state)).toEqual([
      "in_progress",
      "success",
    ]);
    expect(
      gh.statuses.every((s) => s.auto_inactive === false && s.environment === "production"),
    ).toBe(true);
    expect(gh.statuses[0]?.log_url).toBe("https://console/run");
    expect(result.deployment).toBe(id);
  });

  it("marks the earlier successful deployments of the environment inactive when a newer one succeeds, and leaves failed ones as they are", async () => {
    await deploy("1".repeat(40));
    await deploy("2".repeat(40), {
      smoke: async () => ({ ok: false, failures: ["FAIL x"], counts: {} }),
    });
    await deploy("3".repeat(40));
    const [first, second, third] = gh.deployments.map((d) => d.id) as [number, number, number];
    expect(gh.states()).toEqual({ [first]: "inactive", [second]: "failure", [third]: "success" });
    expect(
      gh.statuses.find((s) => s.deployment === first && s.state === "inactive")?.description,
    ).toBe("Superseded by 3333333");
  });

  it("moves each way a run ends to its GitHub state", async () => {
    await deploy("a".repeat(40), {
      settings: async () => ({ values: {}, errors: ["X is not set."] }),
    });
    await deploy("b".repeat(40), {
      tasks: async () => ({
        ran: [],
        skipped: [],
        dryRuns: [],
        notRun: [],
        failed: { id: "1.1-x", commit: "b", at: "t", outcome: "failed", summary: "s" },
      }),
    });
    expect(Object.values(gh.states())).toEqual(["error", "failure"]);
  });

  it("records nothing for a run that stops at the freeze flag", async () => {
    const h = harness({}, { commit: COMMIT });
    h.freeze.record = {
      schema: "deployment-freeze/v1",
      reason: "r",
      commit: "c",
      at: "t",
      logs: "l",
      by: "person",
    };
    h.provenance = provenanceFor(COMMIT);
    await run(h);
    expect(gh.requests).toEqual([]);
  });

  it("goes on deploying when GitHub is down, and says so in the log", async () => {
    gh.failWith = 503;
    const { h, result } = await deploy(COMMIT);
    expect(result.outcome).toBe("succeeded");
    expect(h.logs.join("\n")).toMatch(
      /could not record the GitHub deployment: GitHub POST \/repos\/nikovirtala\/kiro-remote\/deployments: 503 Server Error/,
    );
  });

  it("is refused a token that is wrong, and the error names no token", async () => {
    const api = githubRestApi({ repository: REPO, token: "wrong", baseUrl: gh.url });
    const err = await api
      .createDeployment({
        ref: COMMIT,
        environment: "production",
        description: "d",
        productionEnvironment: true,
      })
      .catch((e: Error) => e);
    expect(String(err)).toContain("401 Bad credentials");
    expect(String(err)).not.toContain("wrong");
  });

  it("describes every outcome in a fixed sentence of names and the short commit, within GitHub's 140 characters", () => {
    for (const o of [
      "succeeded",
      "refused",
      "check-failed",
      "rolled-back",
      "rollback-failed",
      "task-failed",
      "frozen",
    ] as RunOutcome[]) {
      const s = deploymentStatus(o, COMMIT);
      expect(s.description.length, o).toBeLessThanOrEqual(140);
      expect(s.description).toContain(COMMIT.slice(0, 7));
      expect(s.description).not.toContain(COMMIT);
    }
  });
});
