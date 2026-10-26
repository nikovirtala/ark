import { describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

type For = {
  format: string;
  paths: { path: string; issues: { display: string }[]; unresolved: { ref: string }[] }[];
};

describe("issues for", () => {
  it("lists open issues by scope glob and anchor, and closed ones with --all", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Auth");
    const closed = newIssue(repo, "Old");
    expect(runIssues(repo, ["scope", "1", "--set", "src/**", "--commit"]).status).toBe(0);
    await repo.write("src/a.ts", `// issue:${closed}\n// issue:zzzzzzzz\n`);
    expect(runIssues(repo, ["close", "2", "--commit"]).status).toBe(0);
    const r = runJson<For>(repo, ["for", "src/a.ts"]);
    expect(r.status).toBe(0);
    expect(r.json.format).toBe("issues-for/v1");
    expect(r.json.paths[0]?.issues.map((i) => i.display)).toEqual(["?1"]);
    expect(r.json.paths[0]?.unresolved.map((u) => u.ref)).toEqual(["zzzzzzzz"]);
    expect(
      runJson<For>(repo, ["for", "src/a.ts", "--all"]).json.paths[0]?.issues.map((i) => i.display),
    ).toEqual(["?1", "?2"]);
    expect(runIssues(repo, ["for", "src/a.ts"]).stdout).toContain(
      "issue:zzzzzzzz on line 2 is not in this log",
    );
    expect(runIssues(repo, ["for", "src"]).status).toBe(2);
    expect(runIssues(repo, ["for", "../x"]).status).toBe(2);
    expect(runIssues(repo, ["for"]).status).toBe(2);
  });
});
