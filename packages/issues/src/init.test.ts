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
});
