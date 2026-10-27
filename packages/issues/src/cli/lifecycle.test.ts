import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cliEnv, cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

type Write = {
  ok: boolean;
  issue: { state: string; resolution: string | null; blocked: boolean } | null;
  affected: { display: string }[];
  findings: { rule: string; message: string }[];
  written: string[];
};

const subjectOf = (root: string, env: NodeJS.ProcessEnv) =>
  execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, env }).toString().trim();

describe("the lifecycle commands", () => {
  it("follow the state machine: 0 for legal transitions, 1 for illegal ones", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    const steps: [string[], number][] = [
      [["stop", "1"], 1],
      [["reopen", "1", "--reason", "x"], 1],
      [["start", "1"], 0],
      [["start", "1"], 1],
      [["stop", "1", "--reason", "later"], 0],
      [["close", "1"], 0],
      [["close", "1"], 1],
      [["start", "1"], 1],
      [["reopen", "1"], 1],
      [["reopen", "1", "--reason", "regressed"], 0],
      [["start", "?1"], 0],
      [["close", "1", "--reason", "done"], 0],
    ];
    for (const [args, status] of steps) {
      expect(runIssues(repo, args).status, args.join(" ")).toBe(status);
    }
    expect(runIssues(repo, ["start", "9"]).status).toBe(2);
    expect(runIssues(repo, ["start", "1", "--ref", "HEAD"]).status).toBe(2);
  });

  it("checks --resolution and --duplicate-of", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    newIssue(repo, "Two");
    for (const args of [
      ["close", "1", "--duplicate-of", "1"],
      ["close", "1", "--duplicate-of", "?1"],
      ["close", "1", "--duplicate-of", "2", "--resolution", "wontfix"],
      ["close", "1", "--resolution", "duplicate"],
      ["close", "1", "--resolution", "never"],
      ["close", "1", "--duplicate-of", "9"],
    ]) {
      expect(runIssues(repo, args).status, args.join(" ")).toBe(2);
    }
    expect(runIssues(repo, ["close", "1", "--duplicate-of", "1"]).stderr).toContain(
      "an issue can't be a duplicate of itself",
    );
    const noReason = runJson<Write>(repo, ["close", "1", "--resolution", "wontfix"]);
    expect(noReason.status).toBe(1);
    expect(noReason.json.findings.map((f) => f.rule)).toEqual(["issue/reason-required"]);
    expect(noReason.json.written).toEqual([]);
    const dup = runJson<Write>(repo, [
      "close",
      "1",
      "--duplicate-of",
      "?2",
      "--reason",
      "same work",
      "--commit",
    ]);
    expect(dup.status).toBe(0);
    expect(dup.json.affected.map((v) => v.display)).toEqual(["?2"]);
    expect(subjectOf(repo.root, cliEnv(repo))).toBe(
      'docs(issues): close ?1 "one" as a duplicate of ?2',
    );
    expect(
      runIssues(repo, ["close", "2", "--resolution", "wontfix", "--reason", "no", "--commit"])
        .status,
    ).toBe(0);
    expect(subjectOf(repo.root, cliEnv(repo))).toBe(`docs(issues): close ?2 "two" as won't fix`);
  });

  it("refuses the effective self-loop when the close makes it", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    newIssue(repo, "Two");
    newIssue(repo, "Three", ["--depends-on", "2"]);
    const byClose = runJson<Write>(repo, ["close", "2", "--duplicate-of", "3", "--reason", "same"]);
    expect(byClose.status).toBe(1);
    expect(byClose.json.findings.map((f) => f.rule)).toEqual(["issue/cycle"]);
    expect(byClose.json.written).toEqual([]);
  });

  it("warns when starting a blocked issue", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Dependency");
    newIssue(repo, "Blocked", ["--depends-on", "1"]);
    const r = runJson<Write>(repo, ["start", "2"]);
    expect(r.status).toBe(0);
    expect(r.json.findings.map((f) => f.rule)).toEqual(["issue/started-blocked"]);
    expect(r.stderr).toContain(
      "issues: warning: issue/started-blocked: ?2 is blocked by ?1 (open)",
    );
  });

  it("applies the agent close policy and records the agent", async () => {
    await using repo = await cliRepo({
      "docs/issues/issues.toml": "[policy]\nclose_requires_human = true\n",
    });
    newIssue(repo, "Agent work");
    const agent = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "a@example.com" };
    const refused = runJson<Write>(repo, ["close", "1", "--reason", "tests pass"], { env: agent });
    expect(refused.status).toBe(1);
    expect(refused.json.findings.map((f) => f.rule)).toEqual(["issue/agent-closed"]);
    await using open = await cliRepo();
    newIssue(open, "Agent work");
    const noReason = runJson<Write>(open, ["close", "1"], { env: agent });
    expect(noReason.status).toBe(1);
    expect(noReason.json.findings.map((f) => f.rule)).toEqual(["issue/agent-reason-required"]);
    const ok = runIssues(open, ["close", "1", "--reason", "tests pass"], {
      env: { ARK_AGENT: "kiro" },
    });
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain("ARK_ON_BEHALF_OF");
    expect(runIssues(open, ["reopen", "1", "--reason", "not yet"], { env: agent }).status).toBe(0);
  });
});
