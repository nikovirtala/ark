import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseToolConfig, UsageError } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG, parseIssuesConfig } from "./config.js";
import { initIssueLog, starterConfig } from "./init.js";
import { openIssueLog } from "./log.js";
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
