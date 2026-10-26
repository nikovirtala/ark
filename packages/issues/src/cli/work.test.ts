import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cliEnv, cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

type Work = {
  format: string;
  ok: boolean;
  current: { display: string } | null;
  path: string;
  findings: { rule: string }[];
};

describe("issues work", () => {
  it("sets, shows and clears the current issue, per worktree", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    newIssue(repo, "Two");
    expect(runIssues(repo, ["close", "2", "--commit"]).status).toBe(0);
    expect(runJson<Work>(repo, ["work"]).json.current).toBeNull();
    const set = runJson<Work>(repo, ["work", "1"]);
    expect(set.status).toBe(0);
    expect(set.json).toMatchObject({
      format: "issues-work/v1",
      ok: true,
      current: { display: "?1" },
    });
    expect(runIssues(repo, ["work"]).stdout).toContain("?1");
    const closed = runJson<Work>(repo, ["work", "2"]);
    expect(closed.status).toBe(1);
    expect(closed.json.findings.map((f) => f.rule)).toEqual(["issue/work-closed"]);
    const wt = `${repo.root}-wt`;
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: repo.root, env: cliEnv(repo) });
    try {
      expect(runJson<Work>(repo, ["work"], { cwd: wt }).json.current).toBeNull();
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], {
        cwd: repo.root,
        env: cliEnv(repo),
      });
    }
    expect(runJson<Work>(repo, ["work", "--clear"]).json.current).toBeNull();
    expect(runJson<Work>(repo, ["work"]).json.current).toBeNull();
    expect(runIssues(repo, ["work", "1", "--clear"]).status).toBe(2);
    expect(runIssues(repo, ["work", "9"]).status).toBe(2);
  });
});
