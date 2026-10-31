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

  it("lists issues closed, reopened or assigned to you since a revision", async () => {
    await using repo = await cliRepo();
    const closed = await seedIssue(repo, "Closed since");
    const reopened = await seedIssue(repo, "Reopened since");
    const mine = await seedIssue(repo, "Assigned to me");
    const theirs = await seedIssue(repo, "Assigned to someone else");
    const ok = (args: string[]) => expect(runIssues(repo, args).status, args.join(" ")).toBe(0);
    ok(["close", reopened, "--reason", "Done.", "--commit"]);
    const base = Buffer.from((await repo.git.run(["rev-parse", "HEAD"])).stdout)
      .toString("utf8")
      .trim();
    ok(["close", closed, "--reason", "Done.", "--commit"]);
    ok(["reopen", reopened, "--reason", "Not done.", "--commit"]);
    ok(["assign", mine, "--add", "me", "--commit"]);
    ok(["assign", theirs, "--add", "eve@example.com", "--commit"]);
    await seedIssue(repo, "Opened since");
    const doc = runJson<{
      issues: { id: string }[];
      since: { rev: string; commit: string; events: { subject: string; type: string }[] };
    }>(repo, ["list", "--since", base]);
    expect(doc.status).toBe(0);
    expect(new Set(doc.json.issues.map((v) => v.id))).toEqual(new Set([closed, reopened, mine]));
    expect(doc.json.since.rev).toBe(base);
    expect(doc.json.since.commit).toBe(base);
    expect(doc.json.since.events.map((e) => [e.subject, e.type])).toEqual(
      expect.arrayContaining([
        [closed, "closed"],
        [reopened, "reopened"],
        [mine, "assigned"],
      ]),
    );
    expect(
      runJson<{ issues: unknown[] }>(repo, ["list", "--since", base, "--state", "closed"]).json
        .issues,
    ).toHaveLength(1);
    const text = runIssues(repo, ["list", "--since", base]).stdout;
    expect(text).toMatch(/^Changed since [0-9a-f]+ \([0-9a-f]{7}\):\n/);
    expect(text).toContain("Closed since  [new: closed]");
    expect(runIssues(repo, ["list", "--since", "HEAD"]).stdout).toBe("");
    expect(runJson<{ since: unknown }>(repo, ["list"]).json.since).toBeNull();
    for (const args of [
      ["--since", ""],
      ["--since", "-x"],
      ["--since", "nope"],
    ]) {
      expect(runIssues(repo, ["list", ...args]).status, args.join(" ")).toBe(2);
    }
    expect(runIssues(repo, ["list", "--since", base, "--source", "platform"]).status).toBe(2);
    expect(runIssues(repo, ["list", "--source", "Bad"]).stderr).toContain(
      "issues: error: --source must match ^[a-z][a-z0-9-]{0,31}$: Bad\n",
    );
  });
});
