import { describe, expect, it } from "vitest";
import { cliRepo, runIssues, runJson, seedIssue } from "../test-support/cli.js";

describe("issues show", () => {
  it("shows the header, body, relations and comments, and --commits at a ref", async () => {
    await using repo = await cliRepo();
    const a = await seedIssue(repo, "Parent");
    const b = await seedIssue(repo, "Child", { parent: a });
    const doc = runJson<{
      format: string;
      header: { line: string; warning: string | null };
      references: { rel: string; display: string; title: string }[];
      comments: unknown[] | null;
      events: unknown[] | null;
      commits: { subject: string }[] | null;
    }>(repo, ["show", "2"]);
    expect(doc.status).toBe(0);
    expect(doc.json.format).toBe("issues-show/v1");
    expect(doc.json.header).toEqual({ line: `?2 (${b}) · open`, warning: null });
    expect(doc.json.references).toEqual([
      expect.objectContaining({ rel: "parent", display: "?1", title: "Parent" }),
    ]);
    expect(doc.json.comments).toEqual([]);
    expect(doc.json.events).toBeNull();
    expect(doc.json.commits).toBeNull();
    const full = runJson<typeof doc.json>(repo, [
      "show",
      "?2",
      "--history",
      "--commits",
      "--no-comments",
    ]);
    expect(full.json.comments).toBeNull();
    expect(full.json.events).toHaveLength(1);
    expect(full.json.commits?.map((c) => c.subject)).toEqual(['docs(issues): open "child"']);
    const atRef = runJson<typeof doc.json>(repo, ["show", a, "--commits", "--ref", "HEAD~1"]);
    expect(atRef.json.commits?.map((c) => c.subject)).toEqual(['docs(issues): open "parent"']);
    const text = runIssues(repo, ["show", "2"]).stdout;
    expect(text.split("\n")[0]).toBe(`?2 (${b}) · open`);
    expect(text).toContain("## Goal");
    expect(text).toContain("parent       ?1 Parent (open)");
    expect(runIssues(repo, ["show", "9"]).status).toBe(2);
    expect(runIssues(repo, ["show", `platform:${a}`]).status).toBe(2);
  });

  it("shows on whose behalf an agent acted in --history", async () => {
    await using repo = await cliRepo();
    const a = await seedIssue(repo, "Parent");
    const env = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "niko@example.com" };
    expect(runIssues(repo, ["comment", a, "Picked up.", "--commit"], { env }).status).toBe(0);
    expect(runIssues(repo, ["start", a, "--commit"], { env: { ARK_AGENT: "kiro" } }).status).toBe(
      0,
    );
    const history = runIssues(repo, ["show", a, "--history"]).stdout;
    const lines = history.slice(history.indexOf("History:")).split("\n");
    expect(lines.slice(1, 4)).toEqual([
      expect.stringMatching(/^ {2}\S+ opened by Ledger Test$/),
      expect.stringMatching(/^ {2}\S+ commented by kiro on behalf of niko@example\.com$/),
      expect.stringMatching(/^ {2}\S+ started by kiro on behalf of ledger-test@example\.com$/),
    ]);
  });
});
