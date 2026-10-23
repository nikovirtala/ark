import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, InvalidArgumentError, RefNotFoundError, UsageError } from "../errors.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { openToolLog, type ToolLogOptions } from "./tool-log.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files?: Record<string, string>): Promise<TempRepo> {
  const r = await createTempRepo(files === undefined ? {} : { files });
  repos.push(r);
  return r;
}

const open = (r: TempRepo, o: Partial<ToolLogOptions> = {}) =>
  openToolLog({ cwd: r.root, tool: "widget", kind, gitOptions: { env: r.env }, ...o });
const where = async (r: TempRepo, o: Partial<ToolLogOptions> = {}) => {
  const log = await open(r, o);
  return { root: log.layout.root, configPath: log.configPath, notes: log.notes };
};
const rootConfig = (root: string) => `[log]\nroot = "${root}"\n`;

describe("openToolLog", () => {
  it("uses the kind's default root without a config", async () => {
    const r = await repo({ "README.md": "x\n" });
    const log = await open(r);
    expect(log.layout).toEqual({ root: "log", bodies: "items", events: "events" });
    expect(log.config).toBeNull();
    expect(log.configPath).toBeNull();
    expect(log.notes).toEqual([]);
    expect(log.ref).toBeNull();
    expect(log.commit).toBe(await r.git.resolveCommit("HEAD"));
    expect(log.tree.label).toBe("worktree");
    expect(log.kind).toBe(kind);
    expect(log.compiled.kind).toBe(kind);
    expect(log.git.root).toBe(r.root);
  });

  it("has no commit on an unborn HEAD", async () => {
    const r = await repo();
    expect((await open(r)).commit).toBeNull();
  });

  it("reads <root>/<tool>.toml for the default root", async () => {
    const r = await repo({ "log/widget.toml": "[policy]\nx = 1\n" });
    const log = await open(r);
    expect(log.configPath).toBe("log/widget.toml");
    expect(log.config?.raw).toEqual({ policy: { x: 1 } });
    expect(log.config?.file).toBe("log/widget.toml");
  });

  it("lets <root>/<tool>.toml name its own root", async () => {
    const r = await repo({ "log/widget.toml": rootConfig("./log/") });
    expect(await where(r)).toEqual({ root: "log", configPath: "log/widget.toml", notes: [] });
  });

  it("takes the root from <repo>/<tool>.toml, defaulting to the kind's", async () => {
    const r = await repo({ "widget.toml": rootConfig("docs/widgets") });
    expect(await where(r)).toEqual({ root: "docs/widgets", configPath: "widget.toml", notes: [] });
    const plain = await repo({ "widget.toml": "[policy]\n" });
    expect(await where(plain)).toEqual({ root: "log", configPath: "widget.toml", notes: [] });
  });

  it("uses a matching <repo>/<tool>.toml with --root, resolved against cwd", async () => {
    const r = await repo({ "widget.toml": rootConfig("docs/widgets"), "src/a.txt": "a\n" });
    expect(await where(r, { root: "docs/widgets/" })).toEqual({
      root: "docs/widgets",
      configPath: "widget.toml",
      notes: [],
    });
    expect(await where(r, { cwd: join(r.root, "src"), root: "../docs/widgets" })).toEqual({
      root: "docs/widgets",
      configPath: "widget.toml",
      notes: [],
    });
    expect(await where(r, { root: join(r.root, "docs", "widgets") })).toMatchObject({
      root: "docs/widgets",
    });
  });

  it("lets --root override a <repo>/<tool>.toml naming another root, with a note", async () => {
    const r = await repo({ "widget.toml": rootConfig("docs/widgets") });
    const note = "ignoring widget.toml (its root is docs/widgets; --root is fixtures/log)";
    expect(await where(r, { root: "fixtures/log" })).toEqual({
      root: "fixtures/log",
      configPath: null,
      notes: [note],
    });
    await r.write("fixtures/log/widget.toml", "[policy]\n");
    expect(await where(r, { root: "fixtures/log" })).toEqual({
      root: "fixtures/log",
      configPath: "fixtures/log/widget.toml",
      notes: [note],
    });
    const implicit = await repo({ "widget.toml": "[policy]\n" });
    expect(await where(implicit, { root: "other" })).toEqual({
      root: "other",
      configPath: null,
      notes: ["ignoring widget.toml (its root is log; --root is other)"],
    });
  });

  it("refuses two config files for one root", async () => {
    const r = await repo({ "widget.toml": rootConfig("docs/w"), "docs/w/widget.toml": "" });
    const e = await open(r).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).message).toBe(
      "two config files for docs/w: widget.toml and docs/w/widget.toml",
    );
    expect((e as ConfigError).file).toBe("docs/w/widget.toml");
    await expect(open(r, { root: "docs/w" })).rejects.toThrow("two config files for docs/w");
    const implicit = await repo({ "widget.toml": "", "log/widget.toml": "" });
    await expect(open(implicit)).rejects.toThrow("two config files for log");
  });

  it("refuses a <root>/<tool>.toml that names another root", async () => {
    const r = await repo({ "log/widget.toml": rootConfig("elsewhere") });
    await expect(open(r)).rejects.toThrow(
      "log/widget.toml: log.root is elsewhere, but the file is in log",
    );
    const flagged = await repo({ "x/widget.toml": rootConfig("log") });
    await expect(open(flagged, { root: "x" })).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses an invalid [log] root", async () => {
    for (const [text, message] of [
      ["log = 1\n", "widget.toml: log must be a table"],
      ["[log]\nroot = 1\n", "widget.toml: log.root must be a string"],
      ['[log]\nroot = "../x"\n', 'widget.toml: log.root: layout root "../x" must not contain ..'],
      ['[log]\nroot = "."\n', "widget.toml: log.root: layout root"],
    ] as const) {
      const r = await repo({ "widget.toml": text });
      await expect(open(r)).rejects.toThrow(message);
      await expect(open(r)).rejects.toBeInstanceOf(ConfigError);
    }
  });

  it("refuses --root outside the work tree or at its top", async () => {
    const r = await repo();
    await mkdir(join(r.root, "sub"));
    for (const root of ["..", "../elsewhere", "/", ".", "sub/.."]) {
      await expect(open(r, { root })).rejects.toBeInstanceOf(UsageError);
    }
    await expect(open(r, { root: "../x" })).rejects.toThrow(
      `--root ../x is outside the repository ${r.root}`,
    );
  });

  it("reads config and log from the --ref tree", async () => {
    const r = await repo({ "widget.toml": rootConfig("at-head") });
    const head = await r.git.resolveCommit("HEAD");
    await r.write("widget.toml", rootConfig("in-work-tree"));
    expect((await where(r)).root).toBe("in-work-tree");
    const log = await open(r, { ref: "HEAD", reader: "index" });
    expect(log.layout.root).toBe("at-head");
    expect(log.ref).toBe("HEAD");
    expect(log.commit).toBe(head);
    expect(log.tree.commit).toBe(head);
    await expect(open(r, { ref: "nope" })).rejects.toBeInstanceOf(RefNotFoundError);
  });

  it("reads config and log from the index with reader index", async () => {
    const r = await repo({ "widget.toml": rootConfig("committed") });
    await r.write("widget.toml", rootConfig("staged"));
    await r.stage("widget.toml");
    await r.write("widget.toml", rootConfig("unstaged"));
    const log = await open(r, { reader: "index" });
    expect(log.layout.root).toBe("staged");
    expect(log.tree.label).toBe("index");
  });

  it("refuses an invalid tool name", async () => {
    const r = await repo();
    await expect(open(r, { tool: "../adr" })).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
