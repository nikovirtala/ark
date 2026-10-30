import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { parseToolConfig, UsageError } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG, parseIssuesConfig } from "./config.js";
import { agentsPointer, initIssueLog, namesSkill, starterConfig } from "./init.js";
import { openIssueLog } from "./log.js";
import { SKILL_MD } from "./skill.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

const run = promisify(execFile);
const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "x\n", ...files } });
  repos.push(r);
  return r;
}
const open = (r: TempRepo, root?: string) =>
  openIssueLog({
    cwd: r.root,
    ...(root === undefined ? {} : { root }),
    gitOptions: { env: r.env },
  });
const git = async (r: TempRepo, ...args: string[]) =>
  (await run("git", args, { cwd: r.root, env: { ...process.env, ...r.env } as NodeJS.ProcessEnv }))
    .stdout;

describe("initIssueLog", () => {
  it("writes the starter config and the task template, staged", async () => {
    const r = await repo();
    const doc = await initIssueLog(await open(r));
    expect(doc).toEqual({
      format: "issues-init/v1",
      root: "docs/issues",
      config: "docs/issues/issues.toml",
      written: ["docs/issues/issues.toml", "docs/issues/templates/task.md"],
      kept: [],
      removed: [],
      skill: null,
      commit: null,
      notes: [],
    });
    expect(await readFile(join(r.root, "docs/issues/templates/task.md"), "utf8")).toBe(
      BUILTIN_TEMPLATES.task,
    );
    expect((await git(r, "diff", "--cached", "--name-only")).trim().split("\n")).toEqual(
      doc.written,
    );
  });

  it("keeps everything on a rerun", async () => {
    const r = await repo();
    await initIssueLog(await open(r), { templates: ["bug", "task"] });
    const again = await initIssueLog(await open(r), { templates: ["bug", "task"], commit: true });
    expect(again.written).toEqual([]);
    expect(again.kept).toEqual([
      "docs/issues/issues.toml",
      "docs/issues/templates/bug.md",
      "docs/issues/templates/task.md",
    ]);
    expect(again.commit).toBeNull();
  });

  it("writes a repo-level issues.toml for another --root", async () => {
    const r = await repo();
    const doc = await initIssueLog(await open(r, "work/issues"), { templates: ["feature"] });
    expect(doc.config).toBe("issues.toml");
    expect(doc.written).toEqual(["issues.toml", "work/issues/templates/feature.md"]);
    const text = await readFile(join(r.root, "issues.toml"), "utf8");
    expect(text).toContain('root = "work/issues"');
    expect(text).toContain('default_template = "feature"');
    expect((await open(r)).layout.root).toBe("work/issues");
  });

  it("refuses an unknown template", async () => {
    const r = await repo();
    await expect(initIssueLog(await open(r), { templates: ["nope"] })).rejects.toThrow(UsageError);
  });

  it("commits only what it wrote", async () => {
    const r = await repo();
    await r.write("other.txt", "x\n");
    await r.stage("other.txt");
    const doc = await initIssueLog(await open(r), { commit: true });
    expect(doc.commit).not.toBeNull();
    expect((await git(r, "log", "-1", "--format=%s")).trim()).toBe(
      "docs(issues): set up the issue log",
    );
    expect((await git(r, "show", "--name-only", "--format=", "HEAD")).trim().split("\n")).toEqual(
      doc.written,
    );
    expect((await git(r, "status", "--porcelain")).trim()).toBe("A  other.txt");
  });

  it("parses the starter config as the defaults, but for the exclusive prefixes", () => {
    const parsed = parseIssuesConfig(
      parseToolConfig(starterConfig({ root: null, template: "task" })),
      "x",
    );
    expect(parsed).toEqual({ ...DEFAULT_ISSUES_CONFIG, exclusive: ["priority", "type"] });
  });

  it("writes the index key with a comment on its values, and the README shows the file", async () => {
    const text = starterConfig({ root: null, template: "task" });
    expect(text).toContain(
      '# "none", or "committed" to keep index.md generated and fresh in every commit (ADR-0010)\nindex = "none"\n',
    );
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const marker = "`issues init` writes this starter file:\n\n```toml\n";
    const at = readme.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const start = at + marker.length;
    expect(readme.slice(start, readme.indexOf("```\n", start))).toBe(text);
  });
});

describe("initIssueLog and a .gitkeep placeholder (?8)", () => {
  const show = async (r: TempRepo) =>
    (await git(r, "show", "--name-status", "--format=%s", "HEAD")).trim().split("\n");

  it("removes a tracked empty .gitkeep in the same commit", async () => {
    const r = await repo({ "docs/issues/.gitkeep": "" });
    const doc = await initIssueLog(await open(r), { commit: true });
    expect(doc.removed).toEqual(["docs/issues/.gitkeep"]);
    expect(await show(r)).toEqual([
      "docs(issues): set up the issue log",
      "",
      "D\tdocs/issues/.gitkeep",
      "A\tdocs/issues/issues.toml",
      "A\tdocs/issues/templates/task.md",
    ]);
    expect((await git(r, "status", "--porcelain")).trim()).toBe("");
  });

  it("commits the removal after git rm too", async () => {
    const r = await repo({ "docs/issues/.gitkeep": "" });
    await git(r, "rm", "-q", "docs/issues/.gitkeep");
    const doc = await initIssueLog(await open(r), { commit: true });
    expect(doc.removed).toEqual(["docs/issues/.gitkeep"]);
    expect(await show(r)).toContain("D\tdocs/issues/.gitkeep");
    expect((await git(r, "status", "--porcelain")).trim()).toBe("");
  });

  it("keeps a .gitkeep that isn't empty, with a note, and touches nothing when writing nothing", async () => {
    const r = await repo({ "docs/issues/.gitkeep": "keep me\n" });
    const doc = await initIssueLog(await open(r), { commit: true });
    expect(doc.removed).toEqual([]);
    expect(doc.notes).toContain("kept docs/issues/.gitkeep: it isn't empty");
    const s = await repo({ "docs/issues/.gitkeep": "" });
    await initIssueLog(await open(s), { commit: true });
    await s.write("docs/issues/.gitkeep", "");
    await s.stage("docs/issues/.gitkeep");
    const again = await initIssueLog(await open(s), { commit: true });
    expect(again).toMatchObject({ written: [], removed: [], commit: null });
    expect((await git(s, "status", "--porcelain")).trim()).toBe("A  docs/issues/.gitkeep");
  });
});

describe("initIssueLog with skill", () => {
  const SKILL = ".claude/skills/issues/SKILL.md";
  const POINTER = agentsPointer(SKILL);
  const ADR_POINTER =
    "Architecture decisions in this repository are managed by adr: read .claude/skills/adr/SKILL.md before changing architecture, and follow it.";
  const skill = { dir: ".claude/skills/issues", version: "9.9.9" };
  /** A temp repository, never ark's own: AGENTS.md is always read from inside it. */
  async function skillRepo(files: Record<string, string> = {}): Promise<TempRepo> {
    const r = await repo(files);
    expect(`${await realpath(r.root)}${sep}`.startsWith(`${await realpath(tmpdir())}${sep}`)).toBe(
      true,
    );
    return r;
  }
  const agents = (r: TempRepo) => readFile(join(r.root, "AGENTS.md"), "utf8").catch(() => null);
  const status = async (r: TempRepo) => (await git(r, "status", "--porcelain")).trim();
  const subject = async (r: TempRepo) => (await git(r, "log", "-1", "--format=%s")).trim();

  it("writes SKILL.md and the AGENTS.md pointer, staged, and keeps both on a rerun", async () => {
    const r = await skillRepo();
    const doc = await initIssueLog(await open(r), { skill });
    expect(doc).toMatchObject({
      written: ["docs/issues/issues.toml", "docs/issues/templates/task.md", SKILL, "AGENTS.md"],
      kept: [],
      skill: SKILL,
      notes: [],
    });
    expect(await readFile(join(r.root, SKILL), "utf8")).toBe(SKILL_MD);
    expect(await agents(r)).toBe(`${POINTER}\n`);
    expect((await git(r, "diff", "--cached", "--name-only")).trim().split("\n").sort()).toEqual(
      [...doc.written].sort(),
    );
    const again = await initIssueLog(await open(r), { skill });
    expect(again).toMatchObject({
      written: [],
      kept: ["docs/issues/issues.toml", "docs/issues/templates/task.md", SKILL, "AGENTS.md"],
      skill: SKILL,
      notes: [],
    });
  });

  it("writes SKILL.md at the root for an empty dir", async () => {
    const r = await skillRepo();
    const doc = await initIssueLog(await open(r), { skill: { ...skill, dir: "" } });
    expect(doc.skill).toBe("SKILL.md");
    expect(await readFile(join(r.root, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(await agents(r)).toBe(`${agentsPointer("SKILL.md")}\n`);
  });

  it("keeps a SKILL.md that differs, with a note", async () => {
    const r = await skillRepo({ [SKILL]: "my own skill\n" });
    const doc = await initIssueLog(await open(r), { skill });
    expect(doc.kept).toContain(SKILL);
    expect(doc.written).not.toContain(SKILL);
    expect(doc.notes).toEqual([
      expect.stringMatching(
        /^\.claude\/skills\/issues\/SKILL\.md differs from issues 9\.9\.9's skill; delete it and run issues init --skill again to replace it$/,
      ),
    ]);
    expect(await readFile(join(r.root, SKILL), "utf8")).toBe("my own skill\n");
  });

  it.each([
    ["# Agents\n\nBe nice.\n", `# Agents\n\nBe nice.\n\n${POINTER}\n`],
    ["# Agents\nBe nice.", `# Agents\nBe nice.\n\n${POINTER}\n`],
    [`See ${SKILL} first.\n`, `See ${SKILL} first.\n`],
    [`${ADR_POINTER}\n`, `${ADR_POINTER}\n\n${POINTER}\n`],
  ])("adds the pointer to AGENTS.md %j once", async (before, after) => {
    const r = await skillRepo({ "AGENTS.md": before });
    const doc = await initIssueLog(await open(r), { skill });
    expect(await agents(r)).toBe(after);
    expect(doc.written.includes("AGENTS.md")).toBe(before !== after);
    expect(doc.kept.includes("AGENTS.md")).toBe(before === after);
    await initIssueLog(await open(r), { skill });
    expect(await agents(r)).toBe(after);
  });

  it.each([
    [`${ADR_POINTER}\n`, `${ADR_POINTER}\n\n${agentsPointer("SKILL.md")}\n`],
    ["See SKILL.md first.\n", "See SKILL.md first.\n"],
  ])("adds the root pointer to AGENTS.md %j once", async (before, after) => {
    const r = await skillRepo({ "AGENTS.md": before });
    const root = { ...skill, dir: "" };
    const doc = await initIssueLog(await open(r), { skill: root });
    expect(doc.skill).toBe("SKILL.md");
    expect(await agents(r)).toBe(after);
    expect(doc.written.includes("AGENTS.md")).toBe(before !== after);
    expect(doc.kept.includes("AGENTS.md")).toBe(before === after);
    await initIssueLog(await open(r), { skill: root });
    expect(await agents(r)).toBe(after);
  });

  it("refuses AGENTS.md with unstaged changes with a commit, and leaves it unstaged without", async () => {
    const r = await skillRepo({ "AGENTS.md": "# Agents\n" });
    await writeFile(join(r.root, "AGENTS.md"), "# Agents\nEdited.\n");
    const refused = initIssueLog(await open(r), { skill, commit: true });
    await expect(refused).rejects.toThrow(UsageError);
    await expect(refused).rejects.toThrow(
      "AGENTS.md has unstaged changes; stage or discard them, or run without --commit",
    );
    expect(await status(r)).toBe("M AGENTS.md");
    const doc = await initIssueLog(await open(r), { skill });
    expect(doc.notes).toEqual([
      "AGENTS.md had unstaged changes, so the pointer is added but not staged; review it and git add it",
    ]);
    expect(await agents(r)).toBe(`# Agents\nEdited.\n\n${POINTER}\n`);
    expect(await git(r, "diff", "--cached", "--name-only")).not.toContain("AGENTS.md");
  });

  it("refuses an untracked AGENTS.md with a commit, and leaves it unstaged without", async () => {
    const r = await skillRepo();
    await writeFile(join(r.root, "AGENTS.md"), "# Mine\n");
    await expect(initIssueLog(await open(r), { skill, commit: true })).rejects.toThrow(
      "AGENTS.md is not tracked; git add it, or run without --commit",
    );
    expect(await status(r)).toBe("?? AGENTS.md");
    const doc = await initIssueLog(await open(r), { skill });
    expect(doc.notes).toEqual([
      "AGENTS.md is not tracked, so the pointer is added but not staged; review it and git add it",
    ]);
    expect(await agents(r)).toBe(`# Mine\n\n${POINTER}\n`);
    expect(await git(r, "diff", "--cached", "--name-only")).not.toContain("AGENTS.md");
  });

  it("names the commit after the skill only when it writes nothing else", async () => {
    const r = await skillRepo({ "AGENTS.md": "# Agents\n" });
    await initIssueLog(await open(r), { commit: true });
    const doc = await initIssueLog(await open(r), { skill, commit: true });
    expect(doc.written).toEqual([SKILL, "AGENTS.md"]);
    expect(await subject(r)).toBe("docs(issues): set up the issues agent skill");
    expect((await git(r, "show", "--name-only", "--format=", "HEAD")).trim()).toBe(
      `${SKILL}\nAGENTS.md`,
    );
    expect(await status(r)).toBe("");

    // A kept config whose committed index is missing: the index is written with the skill.
    const s = await skillRepo({ "docs/issues/issues.toml": '[log]\nindex = "committed"\n' });
    const indexed = await initIssueLog(await open(s), { skill, commit: true });
    expect(indexed.written).toContain("docs/issues/index.md");
    expect(await subject(s)).toBe("docs(issues): set up the issue log");
  });

  it("removes an empty .gitkeep only when it writes log files", async () => {
    const r = await skillRepo({ "docs/issues/.gitkeep": "" });
    const doc = await initIssueLog(await open(r), { skill, commit: true });
    expect(doc.removed).toEqual(["docs/issues/.gitkeep"]);
    expect(await subject(r)).toBe("docs(issues): set up the issue log");
    expect(await status(r)).toBe("");

    const s = await skillRepo();
    await initIssueLog(await open(s), { commit: true });
    await s.write("docs/issues/.gitkeep", "");
    await s.stage("docs/issues/.gitkeep");
    await git(s, "commit", "-qm", "chore: add a placeholder");
    const skillOnly = await initIssueLog(await open(s), { skill, commit: true });
    expect(skillOnly).toMatchObject({ written: [SKILL, "AGENTS.md"], removed: [] });
    expect(await subject(s)).toBe("docs(issues): set up the issues agent skill");
    expect(await readFile(join(s.root, "docs/issues/.gitkeep"), "utf8")).toBe("");
  });

  it("removes what it wrote when a write fails", async () => {
    const r = await skillRepo();
    // A directory where AGENTS.md goes makes its write fail after SKILL.md was written.
    await mkdir(join(r.root, "AGENTS.md"));
    await writeFile(join(r.root, "AGENTS.md", "x"), "x\n");
    await expect(initIssueLog(await open(r), { skill })).rejects.toThrow();
    for (const path of [SKILL, "docs/issues/issues.toml", "docs/issues/templates/task.md"]) {
      await expect(readFile(join(r.root, path)), path).rejects.toThrow();
    }
    expect(await status(r)).toBe("?? AGENTS.md/");
  });
});

describe("namesSkill", () => {
  const ADR_POINTER =
    "Architecture decisions in this repository are managed by adr: read .claude/skills/adr/SKILL.md before changing architecture, and follow it.";
  it.each<[string, string, boolean]>([
    ["read SKILL.md first", "SKILL.md", true],
    ["`SKILL.md`", "SKILL.md", true],
    ["(./SKILL.md)", "SKILL.md", true],
    ["See SKILL.md.", "SKILL.md", true],
    ["SKILL.md\r", "SKILL.md", true],
    ["# Agents\n\nread SKILL.md\n", "SKILL.md", true],
    [ADR_POINTER, "SKILL.md", false],
    ["../SKILL.md", "SKILL.md", false],
    ["x./SKILL.md", "SKILL.md", false],
    ["MY-SKILL.md", "SKILL.md", false],
    ["SKILL.md.bak", "SKILL.md", false],
    ["SKILL.mdx", "SKILL.md", false],
    [ADR_POINTER, ".claude/skills/adr/SKILL.md", true],
    ["see foo/.claude/skills/issues/SKILL.md", ".claude/skills/issues/SKILL.md", false],
    ["read c++ (x)/SKILL.md", "c++ (x)/SKILL.md", true],
    ["", "SKILL.md", false],
  ])("%j names %j: %s", (text, skill, expected) => {
    expect(namesSkill(text, skill)).toBe(expected);
  });
});
