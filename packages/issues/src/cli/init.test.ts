import { readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { agentsPointer } from "../init.js";
import { SKILL_MD } from "../skill.js";
import { cliRepo, runGit, runIssues, runJson } from "../test-support/cli.js";

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

  it("prints the removed placeholder", async () => {
    await using repo = await cliRepo({ "docs/issues/.gitkeep": "" });
    const out = runIssues(repo, ["init", "--commit"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("removed docs/issues/.gitkeep\n");
  });
});

describe("issues init --skill", { timeout: 60_000 }, () => {
  const SKILL = ".claude/skills/issues/SKILL.md";
  /** A temp repository, never ark's own: AGENTS.md is always read from inside it. */
  const read = (r: TempRepo, path: string) => {
    expect(`${realpathSync(r.root)}${sep}`.startsWith(`${realpathSync(tmpdir())}${sep}`)).toBe(
      true,
    );
    return readFileSync(join(r.root, path), "utf8");
  };
  const git = (r: TempRepo, ...args: string[]) => runGit(r, args).stdout;

  it("writes the skill and the AGENTS.md pointer", async () => {
    await using r = await cliRepo();
    const out = runIssues(r, ["init", "--skill"]);
    expect(out).toEqual({
      status: 0,
      stdout: [
        "wrote docs/issues/issues.toml",
        "wrote docs/issues/templates/task.md",
        `wrote ${SKILL}`,
        "wrote AGENTS.md",
        "Next: issues mcp, from your MCP client's config",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(read(r, SKILL)).toBe(SKILL_MD);
    expect(read(r, "AGENTS.md")).toBe(`${agentsPointer(SKILL)}\n`);
    const again = runJson<{ written: string[]; skill: string | null }>(r, ["init", "--skill"]);
    expect(again.json).toMatchObject({ written: [], skill: SKILL });
    expect(runIssues(r, ["init", "--skill"]).stdout).not.toContain("Next:");
  });

  it("writes to --skill-dir, relative to the working directory", async () => {
    await using r = await cliRepo();
    await mkdir(join(r.root, "sub"));
    const out = runJson<{ skill: string | null }>(
      r,
      ["init", "--skill", "--skill-dir", "../.kiro/skills/issues"],
      { cwd: join(r.root, "sub") },
    );
    expect(out.status).toBe(0);
    expect(out.json.skill).toBe(".kiro/skills/issues/SKILL.md");
    expect(read(r, ".kiro/skills/issues/SKILL.md")).toBe(SKILL_MD);
    expect(read(r, "AGENTS.md")).toBe(`${agentsPointer(".kiro/skills/issues/SKILL.md")}\n`);
  });

  it.each([
    [["--skill-dir", "x"], "--skill-dir needs --skill"],
    [
      ["--skill", "--skill-dir", "../outside"],
      "--skill-dir must be a directory inside the repository",
    ],
    [
      ["--skill", "--skill-dir", ".git/hooks"],
      "--skill-dir must be a directory inside the repository",
    ],
    [["--skill", "--skill-dir", " "], "--skill-dir must be a directory inside the repository"],
  ])("exits 2 for %j, writing nothing", async (args, message) => {
    await using r = await cliRepo();
    const out = runIssues(r, ["init", ...args]);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(`issues: error: ${message}\n`);
    expect(git(r, "status", "--porcelain")).toBe("");
  });

  it("commits the skill on its own after the log was set up", async () => {
    await using r = await cliRepo();
    expect(runIssues(r, ["init", "--commit"]).status).toBe(0);
    const out = runIssues(r, ["init", "--skill", "--commit"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(
      /\ncommitted [0-9a-f]{7}\nNext: issues mcp, from your MCP client's config\n$/,
    );
    expect(git(r, "log", "-1", "--format=%s")).toBe(
      "docs(issues): set up the issues agent skill\n",
    );
    expect(git(r, "status", "--porcelain")).toBe("");
  });
});
