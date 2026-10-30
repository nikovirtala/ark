import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { agentsPointer, INIT_RERUN } from "../init.js";
import { SKILL_MD } from "../skill.js";
import { BUILTIN_TEMPLATES } from "../templates/builtin.js";
import { cliRepo, failingPreCommit, hintCommand, runAdr } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
const read = (r: TempRepo, path: string) => readFile(join(r.root, path), "utf8");

const INIT_KEYS = ["commit", "config", "format", "kept", "notes", "root", "skill", "written"];
type InitDoc = {
  format: string;
  root: string;
  config: string | null;
  written: string[];
  kept: string[];
  skill: string | null;
  commit: string | null;
  notes: string[];
};
function doc(stdout: string): InitDoc {
  const d = JSON.parse(stdout) as InitDoc;
  expect(d.format).toBe("adr-init/v1");
  expect(Object.keys(d).sort()).toEqual(INIT_KEYS);
  return d;
}

const config = (lines: readonly string[]) =>
  [
    "# adr configuration. Every key is optional: https://github.com/nikovirtala/ark/tree/main/packages/adr#config-adrtoml",
    "[log]",
    ...lines,
    "",
    "[commit]",
    '# subject = "docs(adr): {action} {title}"',
    "",
  ].join("\n");

// 01:212, 01:315, design §6.2 and its §16.4 row.
describe("adr init", { timeout: 60_000 }, () => {
  it("writes and stages a config and the nygard template, and keeps them on a second run", async () => {
    const r = await repo();
    const out = runAdr(r, ["init"]);
    expect(out).toEqual({
      status: 0,
      stdout: [
        "Initialized docs/adr",
        "  docs/adr/adr.toml",
        "  docs/adr/templates/nygard.md",
        'Next: adr new "<title>"',
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(await read(r, "docs/adr/adr.toml")).toBe(config(['default_template = "nygard"']));
    expect(await read(r, "docs/adr/templates/nygard.md")).toBe(BUILTIN_TEMPLATES.nygard);
    expect(await git(r, "diff", "--cached", "--name-only")).toBe(
      "docs/adr/adr.toml\ndocs/adr/templates/nygard.md\n",
    );

    const again = runAdr(r, ["init", "--json"]);
    expect(again.status).toBe(0);
    expect(doc(again.stdout)).toEqual({
      format: "adr-init/v1",
      root: "docs/adr",
      config: "docs/adr/adr.toml",
      written: [],
      kept: ["docs/adr/adr.toml", "docs/adr/templates/nygard.md"],
      skill: null,
      commit: null,
      notes: [],
    });
    expect(runAdr(r, ["init", "--commit", "-m", "chore: unused"]).stdout).toBe(
      "Already initialized: docs/adr (kept docs/adr/adr.toml, docs/adr/templates/nygard.md)\n",
    );
  });

  it("commits only what it wrote with a conventional subject, and writes each template once", async () => {
    const r = await repo();
    await r.write("staged.txt", "x\n");
    await r.stage("staged.txt");
    const out = runAdr(r, [
      "init",
      "--template",
      "madr",
      "--template",
      "y-statement",
      "--template",
      "madr",
      "--commit",
      "--json",
    ]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d.written).toEqual([
      "docs/adr/adr.toml",
      "docs/adr/templates/madr.md",
      "docs/adr/templates/y-statement.md",
    ]);
    expect(d.commit).toBe((await git(r, "rev-parse", "HEAD")).trim());
    expect(await git(r, "log", "-1", "--format=%B")).toBe("docs(adr): set up the decision log\n\n");
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).toBe(
      `${d.written.join("\n")}\n`,
    );
    expect(await git(r, "diff", "--cached", "--name-only")).toBe("staged.txt\n");
    expect(await read(r, "docs/adr/adr.toml")).toBe(config(['default_template = "madr"']));

    const nygard = runAdr(r, [
      "init",
      "--template",
      "nygard",
      "--commit",
      "-m",
      "chore: add nygard",
    ]);
    expect(nygard.stdout).toMatch(
      /^Initialized docs\/adr\n {2}docs\/adr\/templates\/nygard\.md\nKept docs\/adr\/adr\.toml\nCommitted [0-9a-f]{7}\.\n/,
    );
    expect(await git(r, "log", "-1", "--format=%s")).toBe("chore: add nygard\n");
  });

  it("names a --root log in a repo-level adr.toml, so later commands find it", async () => {
    const r = await repo();
    const out = runAdr(r, ["init", "--root", "lib/decisions", "--json"]);
    expect(doc(out.stdout)).toMatchObject({
      root: "lib/decisions",
      config: "adr.toml",
      written: ["adr.toml", "lib/decisions/templates/nygard.md"],
      notes: [],
    });
    expect(await read(r, "adr.toml")).toBe(
      config(['root = "lib/decisions"', 'default_template = "nygard"']),
    );
    const created = runAdr(r, [
      "new",
      "Use Aurora",
      "--section",
      "context=a",
      "--section",
      "decision=b",
      "--section",
      "scope=c",
      "--section",
      "consequences=d",
      "--json",
    ]);
    expect(JSON.parse(created.stdout).written[0]).toMatch(/^lib\/decisions\/decisions\//);
  });

  it("writes the config in the root when the repo adr.toml names another log", async () => {
    const r = await repo({ "adr.toml": '[log]\nroot = "docs/adr"\n' });
    const out = runAdr(r, ["init", "--root", "lib/decisions", "--json"]);
    expect(out.status).toBe(0);
    const d = doc(out.stdout);
    expect(d).toMatchObject({
      config: "lib/decisions/adr.toml",
      written: ["lib/decisions/adr.toml", "lib/decisions/templates/nygard.md"],
      notes: [
        "ignoring adr.toml (its root is docs/adr; --root is lib/decisions)",
        "adr.toml names docs/adr; pass --root lib/decisions to use this log",
      ],
    });
    expect(await read(r, "adr.toml")).toBe('[log]\nroot = "docs/adr"\n');
    expect(await read(r, "lib/decisions/adr.toml")).toBe(config(['default_template = "nygard"']));
  });

  it("prints the recovery hint when git refuses the commit, and a rerun commits nothing", async () => {
    const r = await repo();
    const hook = await failingPreCommit(r);
    const before = await git(r, "rev-parse", "HEAD");
    const out = runAdr(r, ["init", "--commit"]);
    expect(out.status).toBe(2);
    expect(out.stderr.split("\n").slice(0, 2)).toEqual([
      "adr: error: git commit failed (exit 1): hook says no",
      "  hook says no",
    ]);
    expect(out.stderr).toContain(`The files are written and staged. ${INIT_RERUN} Staged for`);
    expect(out.stderr).toContain("  docs/adr/adr.toml\n  docs/adr/templates/nygard.md\n");
    expect(hintCommand(out.stderr)).toMatch(
      / commit --cleanup=whitespace -F \S+COMMIT_MSG --only -- docs\/adr\/adr\.toml docs\/adr\/templates\/nygard\.md$/,
    );
    expect(out.stderr).toMatch(/\nThe message has no trailers\.\n$/);

    await rm(hook);
    const again = runAdr(r, ["init", "--commit"]);
    expect(again.status).toBe(0);
    expect(await git(r, "rev-parse", "HEAD")).toBe(before);
  });

  it("exits 2 for an unknown template and for --ref, writing nothing", async () => {
    const r = await repo();
    for (const [args, message] of [
      [
        ["init", "--template", "team"],
        "unknown built-in template team; use nygard, madr or y-statement",
      ],
      [["init", "--ref", "HEAD"], "init does not take --ref; it works on the work tree"],
      [["init", "-m", "x"], "--message needs --commit (or [policy] auto_commit = true)"],
    ] as const) {
      const out = runAdr(r, ["--json", ...args]);
      expect(out.status, args.join(" ")).toBe(2);
      expect(JSON.parse(out.stdout)).toEqual({
        format: "ark-error/v1",
        error: { code: "usage", message },
      });
    }
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});

describe("adr init --skill", { timeout: 60_000 }, () => {
  const SKILL = ".claude/skills/adr/SKILL.md";
  const POINTER = agentsPointer(SKILL);
  const staged = async (r: TempRepo) =>
    (await git(r, "diff", "--cached", "--name-only")).split("\n").filter((l) => l !== "");

  it("writes the skill and an AGENTS.md pointer, and keeps both on a second run", async () => {
    const r = await repo();
    const out = runAdr(r, ["init", "--skill"]);
    expect(out).toEqual({
      status: 0,
      stdout: [
        "Initialized docs/adr",
        "  docs/adr/adr.toml",
        "  docs/adr/templates/nygard.md",
        `  ${SKILL}`,
        "  AGENTS.md",
        "Next: adr mcp, from your MCP client's config",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(await read(r, SKILL)).toBe(SKILL_MD);
    expect(await read(r, "AGENTS.md")).toBe(`${POINTER}\n`);
    expect((await staged(r)).sort()).toEqual(
      ["AGENTS.md", SKILL, "docs/adr/adr.toml", "docs/adr/templates/nygard.md"].sort(),
    );
    const again = runAdr(r, ["init", "--skill", "--json"]);
    expect(doc(again.stdout)).toMatchObject({
      written: [],
      kept: ["docs/adr/adr.toml", "docs/adr/templates/nygard.md", SKILL, "AGENTS.md"],
      skill: SKILL,
      notes: [],
    });
  });

  it("writes to --skill-dir, relative to the working directory", async () => {
    const r = await repo();
    await mkdir(join(r.root, "sub"));
    const out = runAdr(r, ["init", "--skill", "--skill-dir", "../.kiro/skills/adr", "--json"], {
      cwd: join(r.root, "sub"),
    });
    expect(out.status).toBe(0);
    expect(doc(out.stdout)).toMatchObject({ skill: ".kiro/skills/adr/SKILL.md" });
    expect(await read(r, ".kiro/skills/adr/SKILL.md")).toBe(SKILL_MD);
    expect(await read(r, "AGENTS.md")).toBe(`${agentsPointer(".kiro/skills/adr/SKILL.md")}\n`);
  });

  it("adds its pointer next to issues' with --skill-dir .", async () => {
    const ISSUES_POINTER =
      "Issues in this repository are tracked with issues: read .claude/skills/issues/SKILL.md before starting, continuing or finishing work, and follow it.";
    const r = await repo({ "AGENTS.md": `${ISSUES_POINTER}\n` });
    const after = `${ISSUES_POINTER}\n\n${agentsPointer("SKILL.md")}\n`;
    const out = runAdr(r, ["init", "--skill", "--skill-dir", ".", "--json"]);
    expect(out.status).toBe(0);
    expect(doc(out.stdout)).toMatchObject({ skill: "SKILL.md" });
    expect(doc(out.stdout).written).toContain("AGENTS.md");
    expect(await read(r, "AGENTS.md")).toBe(after);
    const again = runAdr(r, ["init", "--skill", "--skill-dir", ".", "--json"]);
    expect(doc(again.stdout).written).not.toContain("AGENTS.md");
    expect(await read(r, "AGENTS.md")).toBe(after);
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
    const r = await repo();
    const out = runAdr(r, ["init", ...args]);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(`adr: error: ${message}\n`);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("keeps a SKILL.md that differs, with a note", async () => {
    const r = await repo({ [SKILL]: "my own skill\n" });
    const out = runAdr(r, ["init", "--skill", "--json"]);
    const d = doc(out.stdout);
    expect(d.kept).toContain(SKILL);
    expect(d.notes).toEqual([
      expect.stringMatching(
        /^\.claude\/skills\/adr\/SKILL\.md differs from adr \S+'s skill; delete it and run adr init --skill again to replace it$/,
      ),
    ]);
    expect(await read(r, SKILL)).toBe("my own skill\n");
  });

  it.each([
    ["# Agents\n\nBe nice.\n", `# Agents\n\nBe nice.\n\n${POINTER}\n`],
    ["# Agents\nBe nice.", `# Agents\nBe nice.\n\n${POINTER}\n`],
    ["# Agents\n\n", `# Agents\n\n${POINTER}\n`],
    [`See ${SKILL} first.\n`, `See ${SKILL} first.\n`],
  ])("adds the pointer to AGENTS.md %j once", async (before, after) => {
    const r = await repo({ "AGENTS.md": before });
    const out = runAdr(r, ["init", "--skill", "--json"]);
    expect(out.status).toBe(0);
    expect(await read(r, "AGENTS.md")).toBe(after);
    const d = doc(out.stdout);
    expect(d.written.includes("AGENTS.md")).toBe(before !== after);
    expect(d.kept.includes("AGENTS.md")).toBe(before === after);
    runAdr(r, ["init", "--skill"]);
    expect(await read(r, "AGENTS.md")).toBe(after);
  });

  it("leaves AGENTS.md with unstaged changes unstaged, and refuses it with --commit", async () => {
    const r = await repo({ "AGENTS.md": "# Agents\n" });
    await writeFile(join(r.root, "AGENTS.md"), "# Agents\nEdited.\n");
    const refused = runAdr(r, ["init", "--skill", "--commit"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe(
      "adr: error: AGENTS.md has unstaged changes; stage or discard them, or run without --commit\n",
    );
    expect(await git(r, "status", "--porcelain")).toBe(" M AGENTS.md\n");
    const out = runAdr(r, ["init", "--skill", "--json"]);
    expect(doc(out.stdout).notes).toEqual([
      "AGENTS.md had unstaged changes, so the pointer is added but not staged; review it and git add it",
    ]);
    expect(await read(r, "AGENTS.md")).toBe(`# Agents\nEdited.\n\n${POINTER}\n`);
    expect(await staged(r)).not.toContain("AGENTS.md");
  });

  it("leaves an untracked AGENTS.md unstaged, and refuses it with --commit", async () => {
    const r = await repo();
    await writeFile(join(r.root, "AGENTS.md"), "# Mine\n");
    const refused = runAdr(r, ["init", "--skill", "--commit"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe(
      "adr: error: AGENTS.md is not tracked; git add it, or run without --commit\n",
    );
    expect(await git(r, "status", "--porcelain")).toBe("?? AGENTS.md\n");
    const out = runAdr(r, ["init", "--skill", "--json"]);
    expect(doc(out.stdout).notes).toEqual([
      "AGENTS.md is not tracked, so the pointer is added but not staged; review it and git add it",
    ]);
    expect(await read(r, "AGENTS.md")).toBe(`# Mine\n\n${POINTER}\n`);
    expect(await staged(r)).not.toContain("AGENTS.md");
  });

  it("commits the skill on its own after the log was set up", async () => {
    const r = await repo({ "AGENTS.md": "# Agents\n" });
    expect(runAdr(r, ["init", "--commit"]).status).toBe(0);
    const out = runAdr(r, ["init", "--skill", "--commit"]);
    expect(out.stdout).toMatch(
      new RegExp(
        `^Set up the adr agent skill\n {2}${SKILL.replace(/\./g, "\\.")}\n {2}AGENTS.md\nKept docs/adr/adr.toml\nKept docs/adr/templates/nygard.md\nCommitted [0-9a-f]{7}.\nNext: adr mcp, from your MCP client's config\n$`,
      ),
    );
    expect(await git(r, "log", "-1", "--format=%s")).toBe(
      "docs(adr): set up the adr agent skill\n",
    );
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).toBe(`${SKILL}\nAGENTS.md\n`);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});
