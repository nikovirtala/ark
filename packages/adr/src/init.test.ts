import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { initDecisionLog, namesSkill } from "./init.js";
import { openDecisionLog } from "./log.js";
import { cliRepo, seedDecision } from "./test-support/cli.js";
import { INDEX, INDEX_CONFIG } from "./test-support/index-repo.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

describe("initDecisionLog commit title (?57)", () => {
  const open = (r: TempRepo) => openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
  const git = async (r: TempRepo, ...args: string[]) =>
    Buffer.from((await r.git.run(args)).stdout).toString("utf8");
  const subject = async (r: TempRepo) => (await git(r, "log", "-1", "--format=%s")).trim();

  it("titles a committing index-only init as the decision log", async () => {
    // A committed-index log whose index.md is missing from HEAD: adr's index step runs after the
    // skill step, so index.md never counts as a log file, yet writing it still sets up the log.
    const r = await cliRepo({ "docs/adr/adr.toml": INDEX_CONFIG });
    repos.push(r);
    await seedDecision(r, "Use Postgres", { accept: true, commit: true });
    // Drop index.md from HEAD, the index and the work tree so init regenerates it alone.
    await git(r, "rm", "-q", "-f", "--ignore-unmatch", "--", INDEX);
    await git(r, "commit", "-q", "-m", "drop the index", "--", INDEX);

    const doc = await initDecisionLog(await open(r), { commit: true });
    expect(doc.written).toEqual([INDEX]);
    expect(doc.commit).not.toBeNull();
    expect(await subject(r)).toBe("docs(adr): set up the decision log");
  });
});

describe("namesSkill", () => {
  const ISSUES_POINTER =
    "Issues in this repository are tracked with issues: read .claude/skills/issues/SKILL.md before starting, continuing or finishing work, and follow it.";
  it.each<[string, string, boolean]>([
    ["read SKILL.md first", "SKILL.md", true],
    ["`SKILL.md`", "SKILL.md", true],
    ["(./SKILL.md)", "SKILL.md", true],
    ["See SKILL.md.", "SKILL.md", true],
    ["SKILL.md\r", "SKILL.md", true],
    ["# Agents\n\nread SKILL.md\n", "SKILL.md", true],
    [ISSUES_POINTER, "SKILL.md", false],
    ["../SKILL.md", "SKILL.md", false],
    ["x./SKILL.md", "SKILL.md", false],
    ["MY-SKILL.md", "SKILL.md", false],
    ["SKILL.md.bak", "SKILL.md", false],
    ["SKILL.mdx", "SKILL.md", false],
    [ISSUES_POINTER, ".claude/skills/issues/SKILL.md", true],
    ["see foo/.claude/skills/adr/SKILL.md", ".claude/skills/adr/SKILL.md", false],
    ["read c++ (x)/SKILL.md", "c++ (x)/SKILL.md", true],
    ["", "SKILL.md", false],
  ])("%j names %j: %s", (text, skill, expected) => {
    expect(namesSkill(text, skill)).toBe(expected);
  });
});
