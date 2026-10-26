import { describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

type Ready = { format: string; issues: { display: string }[]; filter: { mine: string | null } };

describe("issues ready", () => {
  it("lists ready work, with --mine, --label and --limit", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Parent");
    newIssue(repo, "Child", ["--parent", "1", "--label", "type:bug"]);
    newIssue(repo, "Blocked", ["--depends-on", "2"]);
    newIssue(repo, "Mine");
    expect(runIssues(repo, ["assign", "4", "--add", "LEDGER-TEST@example.com"]).status).toBe(0);
    const r = runJson<Ready>(repo, ["ready"]);
    expect(r.status).toBe(0);
    expect(r.json.format).toBe("issues-ready/v1");
    expect(r.json.issues.map((v) => v.display)).toEqual(["?2"]);
    const mine = runJson<Ready>(repo, ["ready", "--mine"]);
    expect(mine.json.issues.map((v) => v.display)).toEqual(["?4", "?2"]);
    expect(mine.json.filter.mine).toBe("ledger-test@example.com");
    expect(runJson<Ready>(repo, ["ready", "--label", "type:feature"]).json.issues).toEqual([]);
    expect(runJson<Ready>(repo, ["ready", "--mine", "--limit", "1"]).json.issues).toHaveLength(1);
    for (const limit of ["0", "1001", "two"]) {
      expect(runIssues(repo, ["ready", "--limit", limit]).status).toBe(2);
    }
    expect(runIssues(repo, ["ready"]).stdout).toContain("?2");
  });
});
