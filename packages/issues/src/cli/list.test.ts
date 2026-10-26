import { describe, expect, it } from "vitest";
import { cliRepo, runIssues, runJson, seedIssue } from "../test-support/cli.js";

describe("issues list", () => {
  it("lists open and in-progress issues by default, and takes filters", async () => {
    await using repo = await cliRepo();
    const a = await seedIssue(repo, "First", { labels: ["type:bug"] });
    const b = await seedIssue(repo, "Second");
    const doc = runJson<{ format: string; issues: { id: string; display: string }[] }>(repo, [
      "list",
    ]);
    expect(doc.status).toBe(0);
    expect(doc.json.format).toBe("issues-list/v1");
    expect(doc.json.issues.map((v) => [v.id, v.display])).toEqual([
      [a, "?1"],
      [b, "?2"],
    ]);
    expect(
      runJson<{ issues: unknown[] }>(repo, ["list", "--label", "type:bug"]).json.issues,
    ).toHaveLength(1);
    expect(
      runJson<{ issues: unknown[] }>(repo, ["list", "--state", "closed"]).json.issues,
    ).toHaveLength(0);
    expect(runJson<{ issues: unknown[] }>(repo, ["list", "--limit", "1"]).json.issues).toHaveLength(
      1,
    );
    expect(
      runJson<{ issues: unknown[] }>(repo, ["list", "--assignee", "me"]).json.issues,
    ).toHaveLength(0);
    const text = runIssues(repo, ["list"]);
    expect(text.stdout).toContain("?1");
    expect(text.stdout).toContain("First  [type:bug]");
    for (const args of [
      ["--state", "done"],
      ["--all", "--state", "open"],
      ["--limit", "0"],
      ["--limit", "1001"],
      ["--limit", "x"],
    ]) {
      expect(runIssues(repo, ["list", ...args]).status, args.join(" ")).toBe(2);
    }
  });

  it("refuses --assignee me for an agent acting for nobody's email", async () => {
    await using repo = await cliRepo();
    const r = runIssues(repo, ["list", "--assignee", "me"], {
      env: { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "not-an-email" },
    });
    expect(r.status).toBe(2);
  });
});
