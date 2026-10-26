import { describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

describe("issues comment", () => {
  it("adds a comment, and refuses empty or oversized text", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    expect(runIssues(repo, ["comment", "1", "picked up", "--commit"]).status).toBe(0);
    expect(
      runJson<{ comments: { text: string }[] }>(repo, ["show", "1"]).json.comments.map(
        (c) => c.text,
      ),
    ).toEqual(["picked up"]);
    expect(runIssues(repo, ["comment", "1", "  "]).status).toBe(2);
    expect(runIssues(repo, ["comment", "1", "x".repeat(65 * 1024)]).status).toBe(2);
  });
});
