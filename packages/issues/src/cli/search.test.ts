import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openIssueLog, readIssues } from "../log.js";
import { type IssueSearchJson, searchIssues } from "../search.js";
import { cliRepo, newIssue, runIssues, runJson, seedIssue } from "../test-support/cli.js";
import { issueSource, networkCommands, sourceToml } from "../test-support/sources.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
const CONFIG = "docs/issues/issues.toml";

describe("issues search", { timeout: 120_000 }, () => {
  it("prints matches with their state warning and excerpt, and the closed note", async () => {
    await using repo = await cliRepo();
    const a = await seedIssue(repo, "Session cookie", {
      sections: { goal: "The cookie is dropped on Safari after a redirect.", done: "Fixed." },
    });
    const b = await seedIssue(repo, "Safari login loops", { dependsOn: [a] });
    const c = await seedIssue(repo, "Old Safari bug");
    expect(runIssues(repo, ["start", a, "--commit"]).status).toBe(0);
    expect(runIssues(repo, ["close", c, "--reason", "Fixed.", "--commit"]).status).toBe(0);

    const out = runIssues(repo, ["search", "safari"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toBe(
      [
        `?2 (${b})  open         Safari login loops`,
        "  BLOCKED by ?1 (in-progress). Finish them first.",
        "  (title match)",
        `?1 (${a})  in-progress  Session cookie`,
        "  The cookie is dropped on Safari after a redirect.",
        '2 issues match "safari".',
        "",
      ].join("\n"),
    );
    expect(out.stderr).toBe("issues: warning: 1 closed issue also matches; add --all to see it\n");

    const all = runIssues(repo, ["search", "safari", "--all"]);
    expect(all.status).toBe(0);
    expect(all.stderr).toBe("");
    expect(all.stdout).toContain(`?3 (${c})  closed       Old Safari bug\n  CLOSED on `);
    expect(all.stdout).toContain('3 issues match "safari".');
  });

  it("shows the heading as the excerpt when only a heading matches", async () => {
    await using repo = await cliRepo();
    const a = await seedIssue(repo, "Session cookie", {
      sections: { goal: "The cookie is dropped.", done: "Fixed." },
    });
    const out = runIssues(repo, ["search", "when"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toBe(
      [`?1 (${a})  open  Session cookie`, "  ## Done when", '1 issue matches "when".', ""].join(
        "\n",
      ),
    );
    const r = runJson<IssueSearchJson>(repo, ["search", "when"]);
    expect(r.json.results.map((x) => [x.matched, x.excerpt])).toEqual([[["body"], "## Done when"]]);
  });

  it("joins the words, every one must match, and prints issues-search/v1", async () => {
    await using repo = await cliRepo();
    const a = await seedIssue(repo, "Login fails on Safari");
    await seedIssue(repo, "Login works on Café");
    expect(runIssues(repo, ["comment", a, "Seen in the café too", "--commit"]).status).toBe(0);

    const r = runJson<IssueSearchJson>(repo, ["search", "LOGIN", "cafe"]);
    expect(r.status).toBe(0);
    expect(r.json.terms).toEqual(["login", "cafe"]);
    expect(r.json.results.map((x) => [x.issue.display, x.matched])).toEqual([
      ["?2", ["title"]],
      ["?1", ["title", "comments"]],
    ]);

    const log = await openIssueLog({ cwd: repo.root, gitOptions: { env: repo.env } });
    const doc = searchIssues(await readIssues(log), { query: "LOGIN cafe" });
    expect(r.json).toEqual(JSON.parse(JSON.stringify(doc)));

    const two = runIssues(repo, ["search", "nothing", "here"]);
    expect(two.status).toBe(0);
    expect(two.stdout).toBe('No open issues match "nothing here".\n');
    expect(runIssues(repo, ["search", "nothing", "--all"]).stdout).toBe(
      'No issues match "nothing".\n',
    );
  });

  it("refuses an invalid query with exit 2", async () => {
    await using repo = await cliRepo();
    await seedIssue(repo, "First");
    const control = runIssues(repo, ["search", "a\u0001b"]);
    expect(control.status).toBe(2);
    expect(control.stderr).toBe(
      "issues: error: the search query must be 1 to 200 characters without control characters\n",
    );
    const words = Array.from({ length: 11 }, (_, i) => `w${i}`);
    const many = runIssues(repo, ["search", ...words]);
    expect(many.status).toBe(2);
    expect(many.stderr).toBe("issues: error: a search takes at most 10 words\n");
    expect(runIssues(repo, ["search"]).status).toBe(2);
  });

  it("searches the tree at --ref", async () => {
    await using repo = await cliRepo();
    await seedIssue(repo, "First");
    await seedIssue(repo, "Second");
    const r = runJson<IssueSearchJson>(repo, ["search", "second", "--ref", "HEAD~1"]);
    expect(r.status).toBe(0);
    expect(r.json.results).toEqual([]);
    expect(r.json.ref).toBe("HEAD~1");
    expect(runJson<IssueSearchJson>(repo, ["search", "first", "--ref", "HEAD~1"]).json.total).toBe(
      1,
    );
  });

  it("searches a cached source without the network", async () => {
    const s = await issueSource(["Provide the platform API", "Document the API"]);
    repos.push(s.src, s.bare);
    const r = await cliRepo({
      [CONFIG]: `[log]\nindex = "committed"\n${sourceToml("platform", s.url)}${sourceToml("decisions", s.url, { kind: "adr" })}`,
    });
    repos.push(r);
    newIssue(r, "Use the platform API");

    const before = runJson<IssueSearchJson>(r, ["search", "api", "--source", "platform"]);
    expect(before.status).toBe(0);
    expect(before.json).toMatchObject({ source: "platform", total: 0, results: [] });
    expect(before.stderr).toContain("platform not fetched; run issues sources fetch");

    expect(runIssues(r, ["sources", "fetch", "platform"]).status).toBe(0);
    const trace = join(r.root, "..", "search-trace.json");
    const after = runJson<IssueSearchJson>(r, ["search", "api", "--source", "platform"], {
      env: { GIT_TRACE2_EVENT: trace },
    });
    expect(after.status).toBe(0);
    expect(after.json.source).toBe("platform");
    expect(after.json.results.map((x) => [x.issue.id, x.issue.display])).toEqual([
      [s.issues[0], "?1"],
      [s.issues[1], "?2"],
    ]);
    expect(await networkCommands(trace)).toEqual([]);

    const local = runJson<IssueSearchJson>(r, ["search", "api"]);
    expect(local.json.results.map((x) => x.issue.title)).toEqual(["Use the platform API"]);

    const adr = runIssues(r, ["search", "api", "--source", "decisions"]);
    expect(adr.status).toBe(2);
    expect(adr.stderr).toBe(
      "issues: error: source decisions is a decision log; --source reads issue logs\n",
    );
    expect(runIssues(r, ["search", "api", "--source", "nope"]).status).toBe(2);
  });
});
