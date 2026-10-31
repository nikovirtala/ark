import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommitFailedError, ConfigError, InvalidArgumentError, UsageError } from "../errors.js";
import { overlayTree } from "../git/tree.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { parseCommitTemplate } from "./commit-message.js";
import type { LogIndexRender } from "./tool-index.js";
import { initToolLog, namesSkill, type ToolInitOptions, type ToolInitSpec } from "./tool-init.js";
import { openToolLog, type ToolLog } from "./tool-log.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "x\n", ...files } });
  repos.push(r);
  return r;
}

const open = (r: TempRepo, o: { root?: string; ref?: string } = {}) =>
  openToolLog({ cwd: r.root, tool: "widget", kind, gitOptions: { env: r.env }, ...o });

/** A widget tool's init: the config names the root and the template. */
const spec = (o: Partial<ToolInitSpec> = {}): ToolInitSpec => ({
  tool: "widget",
  config: {
    index: "none",
    autoCommit: false,
    commitSubject: parseCommitTemplate("docs(widget): {action} {title}", {
      vars: { action: 20 },
      where: "widget.toml: commit.subject",
    }),
  },
  starterConfig: ({ root, template }) =>
    `${root === null ? "" : `root = ${JSON.stringify(root)}\n`}template = ${JSON.stringify(template)}\n`,
  builtins: { plain: "# Plain\n", fancy: "# Fancy\n" },
  defaultTemplates: ["plain"],
  templateChoices: "plain or fancy",
  skillText: "# Widget skill\n",
  agentsPointer: (skill) => `Widgets are managed by widget: read ${skill}.`,
  indexStep: "after-skill",
  renderIndex: async () => "# Widgets\n",
  shallowNote: (at) => `${at} not written: shallow`,
  indexAfter: (root) => `Then run widget index for ${root}.`,
  rerun: "Running widget init again commits nothing.",
  action: "set up",
  commitTitle: ({ logFiles }) => (logFiles > 0 ? "the widget log" : "the widget skill"),
  ...o,
});

const init = async (r: TempRepo, o: ToolInitOptions = {}, t: Partial<ToolInitSpec> = {}) =>
  initToolLog(await open(r), spec(t), o);

const text = (r: TempRepo, path: string) => readFile(join(r.root, path), "utf8");
const out = async (r: TempRepo, args: string[]) =>
  new TextDecoder().decode((await r.git.run(args)).stdout);
const status = async (r: TempRepo) => (await out(r, ["status", "--porcelain"])).trimEnd();
const staged = async (r: TempRepo) =>
  (await out(r, ["diff", "--cached", "--name-only"])).trim().split("\n").filter(Boolean);
const subject = async (r: TempRepo) => (await out(r, ["log", "-1", "--format=%s"])).trim();
const committed = async (r: TempRepo) =>
  (await out(r, ["show", "--name-status", "--format=", "HEAD"])).trim().split("\n");

/** Installs `.git/hooks/<name>` running `script` (sh). */
async function hook(r: TempRepo, name: string, script: string): Promise<void> {
  const path = join(r.git.gitDir, "hooks", name);
  await mkdir(join(r.git.gitDir, "hooks"), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

const SKILL = { dir: ".agents/widget", version: "1.2.3" };
const SKILL_PATH = ".agents/widget/SKILL.md";
const POINTER = `Widgets are managed by widget: read ${SKILL_PATH}.`;

describe("initToolLog: config and templates", () => {
  it("puts the config in the kind's default root, and keeps it on a rerun", async () => {
    const r = await repo();
    const first = await init(r);
    expect(first).toEqual({
      root: "log",
      config: "log/widget.toml",
      written: ["log/widget.toml", "log/templates/plain.md"],
      kept: [],
      removed: [],
      skill: null,
      commit: null,
      notes: [],
    });
    expect(await text(r, "log/widget.toml")).toBe('template = "plain"\n');
    expect(await text(r, "log/templates/plain.md")).toBe("# Plain\n");
    expect(await staged(r)).toEqual(["log/templates/plain.md", "log/widget.toml"]);
    expect(await init(r)).toMatchObject({
      config: "log/widget.toml",
      written: [],
      kept: ["log/widget.toml", "log/templates/plain.md"],
    });
  });

  it("writes a repo-level <tool>.toml naming another root", async () => {
    const r = await repo();
    const doc = await initToolLog(await open(r, { root: "lib/w" }), spec(), {});
    expect(doc).toMatchObject({
      config: "widget.toml",
      written: ["widget.toml", "lib/w/templates/plain.md"],
    });
    expect(await text(r, "widget.toml")).toBe('root = "lib/w"\ntemplate = "plain"\n');
  });

  it("puts the config in the root when the repo-level file names another log, with a note", async () => {
    const r = await repo({ "widget.toml": "[log]\nroot = 'log'\n" });
    const doc = await initToolLog(await open(r, { root: "lib/w" }), spec(), {});
    expect(doc).toMatchObject({
      config: "lib/w/widget.toml",
      written: ["lib/w/widget.toml", "lib/w/templates/plain.md"],
      notes: [
        "ignoring widget.toml (its root is log; --root is lib/w)",
        "widget.toml names log; pass --root lib/w to use this log",
      ],
    });
    expect(await text(r, "lib/w/widget.toml")).toBe('template = "plain"\n');
    expect(await text(r, "widget.toml")).toBe("[log]\nroot = 'log'\n");
  });

  it("writes the chosen templates once each, keeps existing ones, and names the first in the config", async () => {
    const r = await repo({ "log/templates/plain.md": "mine\n" });
    const doc = await init(r, { templates: ["fancy", "plain", "fancy"] });
    expect(doc).toMatchObject({
      written: ["log/widget.toml", "log/templates/fancy.md"],
      kept: ["log/templates/plain.md"],
    });
    expect(await text(r, "log/widget.toml")).toBe('template = "fancy"\n');
    expect(await text(r, "log/templates/plain.md")).toBe("mine\n");
  });

  it("writes no template for an empty list, unless empty means the default", async () => {
    const r = await repo();
    expect((await init(r, { templates: [] })).written).toEqual(["log/widget.toml"]);
    // The config still names the first default template.
    expect(await text(r, "log/widget.toml")).toBe('template = "plain"\n');
    const s = await repo();
    expect((await init(s, { templates: [] }, { defaultWhenEmpty: true })).written).toEqual([
      "log/widget.toml",
      "log/templates/plain.md",
    ]);
  });

  it("refuses an unknown template and a ref, writing nothing", async () => {
    const r = await repo();
    await expect(init(r, { templates: ["plain", "odd"] })).rejects.toThrow(
      new UsageError("unknown built-in template odd; use plain or fancy"),
    );
    await expect(initToolLog(await open(r, { ref: "HEAD" }), spec())).rejects.toThrow(
      new InvalidArgumentError("init writes the work tree; open the log without a ref"),
    );
    expect(await status(r)).toBe("");
  });
});

describe("initToolLog: the skill and AGENTS.md", () => {
  it("writes SKILL.md and a new AGENTS.md, staged, and keeps both on a rerun", async () => {
    const r = await repo();
    const doc = await init(r, { skill: SKILL });
    expect(doc).toMatchObject({
      written: ["log/widget.toml", "log/templates/plain.md", SKILL_PATH, "AGENTS.md"],
      skill: SKILL_PATH,
      notes: [],
    });
    expect(await text(r, SKILL_PATH)).toBe("# Widget skill\n");
    expect(await text(r, "AGENTS.md")).toBe(`${POINTER}\n`);
    expect(await staged(r)).toContain("AGENTS.md");
    expect(await init(r, { skill: SKILL })).toMatchObject({
      written: [],
      kept: ["log/widget.toml", "log/templates/plain.md", SKILL_PATH, "AGENTS.md"],
      notes: [],
    });
  });

  it("writes SKILL.md at the root for an empty dir", async () => {
    const r = await repo();
    const doc = await init(r, { skill: { dir: "", version: "1" } });
    expect(doc.skill).toBe("SKILL.md");
    expect(await text(r, "AGENTS.md")).toBe("Widgets are managed by widget: read SKILL.md.\n");
  });

  it("keeps a SKILL.md that differs, with a note", async () => {
    const r = await repo({ [SKILL_PATH]: "old\n" });
    const doc = await init(r, { skill: SKILL });
    expect(doc.kept).toContain(SKILL_PATH);
    expect(doc.notes).toEqual([
      `${SKILL_PATH} differs from widget 1.2.3's skill; delete it and run widget init --skill again to replace it`,
    ]);
    expect(await text(r, SKILL_PATH)).toBe("old\n");
  });

  it("appends the pointer after one blank line, and keeps an AGENTS.md naming the skill", async () => {
    const r = await repo({ "AGENTS.md": "# Agents\nbe kind" });
    await init(r, { skill: SKILL, commit: true });
    expect(await text(r, "AGENTS.md")).toBe(`# Agents\nbe kind\n\n${POINTER}\n`);
    expect(await committed(r)).toContain("M\tAGENTS.md");
    const s = await repo({ "AGENTS.md": `see ./${SKILL_PATH}\n` });
    const doc = await init(s, { skill: SKILL });
    expect(doc.kept).toContain("AGENTS.md");
    expect(doc.written).not.toContain("AGENTS.md");
    expect(await text(s, "AGENTS.md")).toBe(`see ./${SKILL_PATH}\n`);
  });

  it("refuses AGENTS.md with unstaged changes with a commit, and leaves it unstaged without", async () => {
    const r = await repo({ "AGENTS.md": "# Agents\n" });
    await r.write("AGENTS.md", "# Agents\nedited\n");
    await expect(init(r, { skill: SKILL, commit: true })).rejects.toThrow(
      new UsageError(
        "AGENTS.md has unstaged changes; stage or discard them, or run without --commit",
      ),
    );
    expect(await status(r)).toBe(" M AGENTS.md");
    const doc = await init(r, { skill: SKILL });
    expect(doc.written).toContain("AGENTS.md");
    expect(doc.notes).toEqual([
      "AGENTS.md had unstaged changes, so the pointer is added but not staged; review it and git add it",
    ]);
    expect(await staged(r)).not.toContain("AGENTS.md");
  });

  it("refuses an untracked AGENTS.md with a commit, and leaves it unstaged without", async () => {
    const r = await repo();
    await r.write("AGENTS.md", "# Agents\n");
    await expect(init(r, { skill: SKILL, commit: true })).rejects.toThrow(
      new UsageError("AGENTS.md is not tracked; git add it, or run without --commit"),
    );
    const doc = await init(r, { skill: SKILL });
    expect(doc.notes).toEqual([
      "AGENTS.md is not tracked, so the pointer is added but not staged; review it and git add it",
    ]);
    expect(await text(r, "AGENTS.md")).toBe(`# Agents\n\n${POINTER}\n`);
    expect(await staged(r)).not.toContain("AGENTS.md");
  });

  it("removes what it wrote when a write fails", async () => {
    const r = await repo();
    // A directory where AGENTS.md goes makes its write fail after the other files were written.
    await mkdir(join(r.root, "AGENTS.md"));
    await writeFile(join(r.root, "AGENTS.md", "x"), "x\n");
    await expect(init(r, { skill: SKILL })).rejects.toThrow();
    for (const path of [SKILL_PATH, "log/widget.toml", "log/templates/plain.md"]) {
      await expect(readFile(join(r.root, path)), path).rejects.toThrow();
    }
    expect(await status(r)).toBe("?? AGENTS.md/");
  });

  it("leaves AGENTS.md as it is when replacing it fails", async () => {
    const r = await repo({ "AGENTS.md": "# Agents\n" });
    const log = await open(r);
    // The tree init read AGENTS.md from no longer matches the file, so the replace refuses.
    const stale: ToolLog = {
      ...log,
      tree: overlayTree(log.tree, { "AGENTS.md": new TextEncoder().encode("# Old\n") }),
    };
    await expect(initToolLog(stale, spec(), { skill: SKILL })).rejects.toThrow();
    expect(await text(r, "AGENTS.md")).toBe("# Agents\n");
    await expect(readFile(join(r.root, SKILL_PATH))).rejects.toThrow();
    expect(await status(r)).toBe("");
  });
});

describe("initToolLog: the commit", () => {
  it("commits only what it wrote, titled by commitTitle", async () => {
    const r = await repo();
    await r.write("other.txt", "x\n");
    await r.stage("other.txt");
    const seen: unknown[] = [];
    const doc = await init(
      r,
      { commit: true, skill: SKILL },
      {
        commitTitle: (o) => {
          seen.push(o);
          return "the widget log";
        },
      },
    );
    expect(doc.commit).toBe(await r.git.resolveCommit("HEAD"));
    expect(await subject(r)).toBe("docs(widget): set up the widget log");
    expect(seen).toEqual([
      {
        logFiles: 2,
        written: ["log/widget.toml", "log/templates/plain.md", SKILL_PATH, "AGENTS.md"],
        removed: [],
        skill: SKILL_PATH,
      },
    ]);
    expect(await status(r)).toBe("A  other.txt");
  });

  it("commits by auto_commit, takes a message, and commits nothing when it writes nothing", async () => {
    const r = await repo();
    const config = { ...spec().config, autoCommit: true };
    const doc = await init(r, { message: "chore: start widgets" }, { config });
    expect(doc.commit).not.toBeNull();
    expect(await subject(r)).toBe("chore: start widgets");
    expect((await init(r, {}, { config })).commit).toBeNull();
    expect(await subject(r)).toBe("chore: start widgets");
  });

  it("titles a skill-only commit with no log files", async () => {
    const r = await repo();
    await init(r, { commit: true });
    await init(r, { commit: true, skill: SKILL });
    expect(await subject(r)).toBe("docs(widget): set up the widget skill");
  });

  it("needs a git identity to commit", async () => {
    const r = await repo();
    const env = { ...r.env, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined };
    const log = await openToolLog({ cwd: r.root, tool: "widget", kind, gitOptions: { env } });
    await expect(initToolLog(log, spec(), { commit: true })).rejects.toThrow(
      new ConfigError("--commit needs a git identity; set git user.name and user.email"),
    );
    expect(await status(r)).toBe("");
  });
});

describe("initToolLog: the placeholder", () => {
  const placeholder = { removePlaceholder: true };

  it("removes a tracked empty .gitkeep in the same commit", async () => {
    const r = await repo({ "log/.gitkeep": "" });
    const doc = await init(r, { commit: true }, placeholder);
    expect(doc.removed).toEqual(["log/.gitkeep"]);
    expect(await committed(r)).toContain("D\tlog/.gitkeep");
    expect(await status(r)).toBe("");
  });

  it("drops a new staged one without committing a deletion", async () => {
    const r = await repo();
    await r.write("log/.gitkeep", "");
    await r.stage("log/.gitkeep");
    const doc = await init(r, { commit: true }, placeholder);
    expect(doc.removed).toEqual(["log/.gitkeep"]);
    expect(await committed(r)).not.toContain("D\tlog/.gitkeep");
    expect(await status(r)).toBe("");
  });

  it("keeps one that isn't empty, with a note, and one when writing only the skill", async () => {
    const r = await repo({ "log/.gitkeep": "keep\n" });
    const doc = await init(r, {}, placeholder);
    expect(doc).toMatchObject({ removed: [], notes: ["kept log/.gitkeep: it isn't empty"] });
    const s = await repo({
      "log/widget.toml": "",
      "log/templates/plain.md": "",
      "log/.gitkeep": "",
    });
    expect(await init(s, { skill: SKILL }, placeholder)).toMatchObject({ removed: [] });
    expect(await text(s, "log/.gitkeep")).toBe("");
  });

  it("leaves an empty one alone without the option", async () => {
    const r = await repo({ "log/.gitkeep": "" });
    const doc = await init(r, { commit: true });
    expect(doc.removed).toEqual([]);
    expect(await text(r, "log/.gitkeep")).toBe("");
    expect(await committed(r)).not.toContain("D\tlog/.gitkeep");
  });
});

describe("initToolLog: the committed index", () => {
  const committedIndex = { ...spec().config, index: "committed" as const };
  /** Lists the files under `log/` the render's tree holds, and the commit it builds on. */
  const listing: LogIndexRender = async (_git, at) =>
    `${(await at.tree.list("log")).map((e) => e.path).join("\n")}\n`;
  const indexed = (o: Partial<ToolInitSpec> = {}) => ({
    config: committedIndex,
    renderIndex: listing,
    ...o,
  });

  it("commits the index of HEAD's tree plus its files, then refreshes the work tree's", async () => {
    const r = await repo({ "log/a.txt": "a\n" });
    await r.write("log/b.txt", "b\n");
    const doc = await init(r, { commit: true }, indexed());
    expect(doc.written).toEqual(["log/widget.toml", "log/templates/plain.md", "log/index.md"]);
    expect(await out(r, ["show", "HEAD:log/index.md"])).toBe(
      "log/a.txt\nlog/templates/plain.md\nlog/widget.toml\n",
    );
    // The refresh renders the work tree, which now holds index.md too.
    expect(await text(r, "log/index.md")).toBe(
      "log/a.txt\nlog/b.txt\nlog/index.md\nlog/templates/plain.md\nlog/widget.toml\n",
    );
  });

  it("renders the work tree without a commit, and keeps an existing index.md", async () => {
    const r = await repo({ "log/a.txt": "a\n" });
    await r.write("log/b.txt", "b\n");
    await init(r, {}, indexed());
    expect(await text(r, "log/index.md")).toBe(
      "log/a.txt\nlog/b.txt\nlog/templates/plain.md\nlog/widget.toml\n",
    );
    expect(await staged(r)).toContain("log/index.md");
    expect((await init(r, {}, indexed())).kept).toContain("log/index.md");
  });

  it("writes no index without [log] index = committed", async () => {
    const r = await repo();
    expect((await init(r, {}, { renderIndex: listing })).written).not.toContain("log/index.md");
  });

  it("notes a shallow clone's missing numbers and writes no index", async () => {
    const r = await repo();
    const doc = await init(r, { commit: true }, indexed({ renderIndex: async () => null }));
    expect(doc.written).toEqual(["log/widget.toml", "log/templates/plain.md"]);
    expect(doc.notes).toEqual(["log/index.md not written: shallow"]);
  });

  it("runs the index step after the skill: index.md is no log file, and AGENTS.md is refused first", async () => {
    const r = await repo({ "log/widget.toml": "", "log/templates/plain.md": "" });
    const seen: number[] = [];
    const commitTitle = (o: { logFiles: number }) => {
      seen.push(o.logFiles);
      return "the widget skill";
    };
    const doc = await init(r, { commit: true, skill: SKILL }, indexed({ commitTitle }));
    // AGENTS.md is always written last.
    expect(doc.written).toEqual([SKILL_PATH, "log/index.md", "AGENTS.md"]);
    expect(seen).toEqual([0]);

    const s = await repo({ "AGENTS.md": "# Agents\n" });
    await s.write("AGENTS.md", "edited\n");
    const failing = async () => {
      throw new Error("render failed");
    };
    await expect(
      init(s, { commit: true, skill: SKILL }, indexed({ renderIndex: failing })),
    ).rejects.toThrow(UsageError);
  });

  it("runs the index step before the skill: index.md is a log file, and the render fails first", async () => {
    const r = await repo({ "log/widget.toml": "", "log/templates/plain.md": "" });
    const seen: number[] = [];
    const commitTitle = (o: { logFiles: number }) => {
      seen.push(o.logFiles);
      return "the widget log";
    };
    const before = indexed({ commitTitle, indexStep: "before-skill" });
    const doc = await init(r, { commit: true, skill: SKILL }, before);
    expect(doc.written).toEqual(["log/index.md", SKILL_PATH, "AGENTS.md"]);
    expect(seen).toEqual([1]);

    const s = await repo({ "AGENTS.md": "# Agents\n" });
    await s.write("AGENTS.md", "edited\n");
    const failing = async () => {
      throw new Error("render failed");
    };
    await expect(
      init(
        s,
        { commit: true, skill: SKILL },
        indexed({ renderIndex: failing, indexStep: "before-skill" }),
      ),
    ).rejects.toThrow("render failed");
  });

  it("ends the recovery hint with the index step when git refuses a commit with index.md", async () => {
    const r = await repo();
    await hook(r, "pre-commit", 'echo "hook says no" >&2\nexit 1');
    const failure = await init(r, { commit: true }, indexed()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CommitFailedError);
    const message = (failure as Error).message;
    expect(message).toContain(
      "The files are written and staged. Running widget init again commits nothing. Staged for",
    );
    expect(message).toContain("  log/index.md\n");
    expect(message.endsWith("\nThen run widget index for log.")).toBe(true);

    const s = await repo();
    await hook(s, "pre-commit", "exit 1");
    const plain = await init(s, { commit: true }).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(CommitFailedError);
    expect((plain as Error).message).not.toContain("Then run widget index");
  });

  it("notes a stale index.md when the refresh after the commit fails", async () => {
    const r = await repo();
    const refresh: LogIndexRender = async (git, at) => {
      if (at.tree.label === "worktree") throw new Error("boom\nmore");
      return listing(git, at);
    };
    const doc = await init(r, { commit: true }, indexed({ renderIndex: refresh }));
    expect(doc.commit).toBe(await r.git.resolveCommit("HEAD"));
    expect(doc.notes).toEqual(["log/index.md may be stale: boom; run widget index"]);
  });
});

describe("namesSkill", () => {
  it.each<[string, string, boolean]>([
    ["read SKILL.md first", "SKILL.md", true],
    ["(./SKILL.md)", "SKILL.md", true],
    ["See SKILL.md.", "SKILL.md", true],
    ["../SKILL.md", "SKILL.md", false],
    ["MY-SKILL.md", "SKILL.md", false],
    ["SKILL.md.bak", "SKILL.md", false],
    ["see foo/.claude/skills/adr/SKILL.md", ".claude/skills/adr/SKILL.md", false],
    ["read c++ (x)/SKILL.md", "c++ (x)/SKILL.md", true],
  ])("%j names %j: %s", (text, skill, expected) => {
    expect(namesSkill(text, skill)).toBe(expected);
  });
});
