import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { initDecisionLog, namesSkill } from "./init.js";
import { openDecisionLog } from "./log.js";
import { cliRepo, runAdr, seedDecision } from "./test-support/cli.js";
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

describe("adr init --setup (the agent setup plumbing)", () => {
  const exists = (r: TempRepo, p: string) =>
    readFile(join(r.root, p)).then(
      () => true,
      () => false,
    );

  it("writes the MCP config, hooks, permissions and the committed lock for each harness", async () => {
    const r = await cliRepo();
    const run = runAdr(r, ["init", "--setup", "--no-commit"]);
    expect(run.status).toBe(0);
    expect(await exists(r, ".mcp.json")).toBe(true);
    expect(await exists(r, ".claude/settings.json")).toBe(true);
    expect(await exists(r, ".claude/hooks/session-start.sh")).toBe(true);
    expect(await exists(r, ".kiro/settings/mcp.json")).toBe(true);
    expect(await exists(r, "ark-setup.lock")).toBe(true);
    // The MCP pin is an exact version, and the env never carries ARK_ON_BEHALF_OF's value (R4/R8).
    const mcp = await readFile(join(r.root, ".mcp.json"), "utf8");
    expect(mcp).toContain("@nikovirtala/adr@0.5.10");
    expect(mcp).not.toContain("workspace:");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected shell placeholder
    expect(mcp).toContain("${ARK_ON_BEHALF_OF}");
    // The skill went to both harnesses.
    expect(await exists(r, ".claude/skills/adr/SKILL.md")).toBe(true);
    expect(await exists(r, ".kiro/skills/adr/SKILL.md")).toBe(true);
  });

  it("opts a piece out with --no-mcp and a harness out with --harness kiro", async () => {
    const r = await cliRepo();
    const run = runAdr(r, ["init", "--setup", "--no-mcp", "--harness", "kiro", "--no-commit"]);
    expect(run.status).toBe(0);
    expect(await exists(r, ".mcp.json")).toBe(false);
    expect(await exists(r, ".kiro/settings/mcp.json")).toBe(false);
    // Claude hooks still written; Kiro opted out entirely.
    expect(await exists(r, ".claude/hooks/session-start.sh")).toBe(true);
    expect(await exists(r, ".kiro/hooks/session-start.sh")).toBe(false);
  });

  it("refuses --no-mcp without --setup", async () => {
    const r = await cliRepo();
    const run = runAdr(r, ["init", "--no-mcp"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--no-mcp needs --setup");
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
