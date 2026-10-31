import { rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceConfig } from "../sources/config.js";
import { readSources } from "../sources/read.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { runCli } from "./run.js";
import { sourcesCommand } from "./sources-command.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

async function setup() {
  const src = await repo({ files: { "docs/adr/README.md": "v1\n" } });
  const remote = await repo({ bare: true });
  await src.git.run(["push", "-q", remote.root, "main"]);
  const main = await repo({ files: { "a.txt": "a\n" } });
  const head = (await src.git.resolveCommit("HEAD")) ?? "";
  const s = (name: string, o: Partial<SourceConfig> = {}): SourceConfig => ({
    name,
    kind: "widget",
    url: remote.root,
    ref: "main",
    root: null,
    ...o,
  });
  return { remote, main, head, s };
}

async function call(
  r: TempRepo,
  argv: readonly string[],
  sources: readonly SourceConfig[],
  skipped: readonly SourceConfig[] = [],
) {
  let stdout = "";
  let stderr = "";
  const cmd = sourcesCommand({
    format: "w-sources/v1",
    tool: "w",
    async open() {
      return { git: r.git, sources, skipped, configPath: "w.toml" };
    },
  });
  const code = await runCli(
    { name: "w", version: "0.0.0", summary: "widgets", commands: [cmd] },
    {
      argv,
      cwd: r.root,
      env: {},
      stdout: {
        write: (x) => {
          stdout += x;
        },
      },
      stderr: {
        write: (x) => {
          stderr += x;
        },
      },
      interactive: false,
      stdoutIsTTY: false,
    },
  );
  return { code, stdout, stderr };
}

describe("sourcesCommand", () => {
  it("fetches every source in config order and lists the skipped ones", async () => {
    const { main, head, s } = await setup();
    const tracker = s("tracker", { kind: "issues", url: "/nowhere.git" });
    const out = await call(main, ["sources", "fetch"], [s("b"), s("a")], [tracker]);
    expect(out).toEqual({
      code: 0,
      stdout:
        `fetched b (main) at ${head.slice(0, 12)}\n` +
        `fetched a (main) at ${head.slice(0, 12)}\n` +
        "skipped tracker (kind issues isn't read by w)\n",
      stderr: "",
    });
    const [cached] = await readSources(main.git, [s("a")], { fetch: "cache" });
    expect(cached?.status.commit).toBe(head);
  });

  it("fetches only the named sources, once each", async () => {
    const { main, head, s } = await setup();
    const out = await call(main, ["--json", "sources", "fetch", "b", "b"], [s("a"), s("b")]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      format: "w-sources/v1",
      sources: [{ name: "b", kind: "widget", ref: "main", commit: head, fetched: true }],
      skipped: [],
      notes: [],
    });
    const [a] = await readSources(main.git, [s("a")], { fetch: "cache" });
    expect(a?.status.commit).toBeNull();
  });

  it("refuses unknown and skipped names, --ref, bad names and more than 32 names", async () => {
    const { main, s } = await setup();
    const tracker = s("tracker", { kind: "issues" });
    const err = async (argv: string[]) => {
      const out = await call(main, argv, [s("a"), s("b")], [tracker]);
      expect(out.code).toBe(2);
      return out.stderr;
    };
    expect(await err(["sources", "fetch", "c"])).toBe(
      "w: error: unknown source c; the sources are a, b, tracker\n",
    );
    expect(await err(["sources", "fetch", "tracker"])).toBe(
      "w: error: source tracker has kind issues, which w doesn't read\n",
    );
    expect(await err(["sources", "fetch", "Bad"])).toBe(
      "w: error: source names must match ^[a-z][a-z0-9-]{0,31}$: Bad\n",
    );
    expect(await err(["sources", "pull"])).toContain("unknown sources action");
    expect(await err(["sources", "fetch", "--ref", "HEAD"])).toContain("--ref");
    const many = Array.from({ length: 33 }, (_, i) => `s${i}`);
    expect(await err(["sources", "fetch", ...many])).toContain("unexpected argument");
  });

  it("says so without sources", async () => {
    const { main } = await setup();
    expect(await call(main, ["sources", "fetch"], [])).toEqual({
      code: 0,
      stdout: "no [[sources]] in w.toml\n",
      stderr: "",
    });
  });

  it("stops at the first failure, keeping earlier sources fetched", async () => {
    const { main, head, s, remote } = await setup();
    const gone = s("gone", { url: join(main.root, "..", "gone.git") });
    const out = await call(main, ["sources", "fetch"], [s("a"), gone, s("c")]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/^w: error: cannot fetch source gone \(main\): /);
    const [a, c] = await readSources(main.git, [s("a"), s("c")], { fetch: "cache" });
    expect(a?.status.commit).toBe(head);
    expect(c?.status.commit).toBeNull();
    // A refetch that fails with an older pin is an error too.
    await rename(remote.root, `${remote.root}.moved`);
    const stale = await call(main, ["sources", "fetch", "a"], [s("a")]);
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain(`; the cache still pins ${head.slice(0, 12)}`);
    await rename(`${remote.root}.moved`, remote.root);
  });
});
