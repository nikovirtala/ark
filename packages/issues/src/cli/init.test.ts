import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliRepo, runIssues, runJson } from "../test-support/cli.js";

describe("issues init", () => {
  it("writes the config and templates, keeps them on a rerun, and commits", async () => {
    await using repo = await cliRepo();
    const first = runJson<{ written: string[] }>(repo, [
      "init",
      "--template",
      "bug",
      "--template",
      "task",
      "--commit",
    ]);
    expect(first.status).toBe(0);
    expect(first.json.written).toEqual([
      "docs/issues/issues.toml",
      "docs/issues/templates/bug.md",
      "docs/issues/templates/task.md",
    ]);
    expect(readFileSync(join(repo.root, "docs/issues/issues.toml"), "utf8")).toContain(
      'default_template = "bug"',
    );
    const again = runIssues(repo, ["init"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("kept docs/issues/issues.toml");
    expect(runIssues(repo, ["init", "--template", "nope"]).status).toBe(2);
    expect(runIssues(repo, ["init", "--ref", "HEAD"]).status).toBe(2);
  });
});
