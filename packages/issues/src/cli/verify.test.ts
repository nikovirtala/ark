import { describe, expect, it } from "vitest";
import { openIssueLog } from "../log.js";
import { cliRepo, REPO_HUMAN, runIssues, runJson, seedIssue } from "../test-support/cli.js";
import { closeIssue } from "../write.js";

describe("issues verify", () => {
  it("passes a clean log and fails a broken one in text, json and github formats", async () => {
    await using repo = await cliRepo();
    runIssues(repo, ["init", "--commit"]);
    const a = await seedIssue(repo, "One");
    expect(runIssues(repo, ["verify"]).status).toBe(0);
    await repo.write(
      `docs/issues/events/${a}/20990101T000000Z-0000-linked.yaml`,
      [
        "envelope: ledger/v1",
        "kind: issue",
        "schema: issue/v1",
        "id: 01J00000000000000000000000",
        `subject: ${a}`,
        "type: linked",
        "at: 2099-01-01T00:00:00Z",
        "actor:",
        "  kind: human",
        "  name: Test",
        "  email: test@example.com",
        "  agent: null",
        "  on_behalf_of: null",
        "data:",
        "  to: zzzzzzzz",
        "  rel: depends-on",
        "",
      ].join("\n"),
    );
    const text = runIssues(repo, ["verify"]);
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("[issue/reference-missing]");
    expect(text.stdout).not.toContain("identity/");
    const json = runJson<{ format: string }>(repo, ["verify"]);
    expect(json.status).toBe(1);
    expect(json.json.format).toBe("ledger-findings/v1");
    const github = runIssues(repo, ["verify", "--format", "github"]);
    expect(github.status).toBe(1);
    expect(github.stdout).toMatch(/^::error /m);
    expect(runIssues(repo, ["verify", "--staged"]).status).toBe(0);
    await repo.stage(".");
    expect(runIssues(repo, ["verify", "--staged"]).status).toBe(1);
  });

  it('fails on warnings with [verify] fail_on = "warning"', async () => {
    await using repo = await cliRepo({
      "docs/issues/issues.toml": '[verify]\nfail_on = "warning"\n',
    });
    const a = await seedIssue(repo, "Parent");
    await seedIssue(repo, "Child", { parent: a });
    expect(runIssues(repo, ["verify"]).status).toBe(0);
    const log = await openIssueLog({ cwd: repo.root, gitOptions: { env: repo.env } });
    expect((await closeIssue(log, { id: a, actor: REPO_HUMAN })).ok).toBe(true);
    const r = runIssues(repo, ["verify"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("issue/closed-with-open-children");
  });
});
