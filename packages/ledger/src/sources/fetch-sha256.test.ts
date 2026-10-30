import { chmod, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceFetchError } from "../errors.js";
import { Git } from "../git/git.js";
import { MemoryTree } from "../git/tree.js";
import { realGit } from "../testing/spawn-log.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { SourceConfig } from "./config.js";
import { fetchSource } from "./fetch.js";
import { readSources } from "./read.js";
import { resolveQualifiedId, sourceLogRef } from "./resolve.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(o: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

const text = new TextDecoder();

/** A SHA-256 source repository, used directly as the url, and the SHA-1 repository that fetches it. */
async function setup() {
  const src = await repo({
    objectFormat: "sha256",
    files: {
      "docs/adr/README.md": "v1\n",
      "docs/adr/events/k3f9q8a1/20260101T000000Z-aaaa-proposed.yaml": "x\n",
    },
  });
  const main = await repo({ objectFormat: "sha1", files: { "a.txt": "a\n" } });
  const head = (await src.git.resolveCommit("HEAD")) ?? "";
  return { src, main, head };
}

function source(o: Partial<SourceConfig> & { url: string }): SourceConfig {
  return { name: "platform", kind: "adr", ref: "main", root: null, ...o };
}

async function readme(tree: { read(p: string): Promise<Uint8Array | null> }) {
  const bytes = await tree.read("docs/adr/README.md");
  return bytes === null ? null : text.decode(bytes);
}

/** `main`'s repository with git's trace2 events written to `file`. */
function traced(main: TempRepo, file: string): Promise<Git> {
  return Git.open(main.root, {
    ...main.git.options,
    env: { ...main.git.options.env, GIT_TRACE2_EVENT: file },
  });
}

/** The git commands a trace2 event file records, from its `cmd_name` events. */
async function tracedCommands(file: string): Promise<string[]> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { event: string; name?: string })
    .filter((e) => e.event === "cmd_name" && e.name !== undefined)
    .map((e) => e.name as string);
}

describe("fetchSource with SHA-256 sources", () => {
  it("fetches a SHA-256 source by branch into a SHA-256 cache", async () => {
    const { src, main, head } = await setup();
    const s = source({ url: src.root });
    const f = await fetchSource(main.git, s);
    expect(f.commit).toHaveLength(64);
    expect(f).toMatchObject({ commit: head, stale: false });
    expect(await (await Git.openGitDir(f.cacheDir, main.git.options)).objectFormat()).toBe(
      "sha256",
    );
    expect(await readme(f.tree)).toBe("v1\n");

    await src.write("docs/adr/README.md", "v2\n");
    const next = await src.commit("v2", { all: true });
    const g = await fetchSource(main.git, s);
    expect(g).toMatchObject({ commit: next, stale: false, cacheDir: f.cacheDir });
    expect(await readme(g.tree)).toBe("v2\n");
  });

  it("reads a SHA-256 source's log through readSources", async () => {
    const { src, main, head } = await setup();
    const [read] = await readSources(main.git, [source({ url: src.root })], {
      fetch: "network",
    });
    expect(read?.status).toMatchObject({ commit: head, fetched: true });
    if (read?.source == null) throw new Error("source not read");
    const logs = {
      local: {
        name: null,
        kind: "adr",
        layout: { root: "docs/adr", bodies: null, events: "events" },
        tree: new MemoryTree({}),
        commit: null,
      },
      sources: new Map([
        [
          "platform",
          sourceLogRef(read.source, {
            layout: { bodies: null, events: "events" },
            defaultRoot: "docs/adr",
          }),
        ],
      ]),
    };
    expect(await resolveQualifiedId("platform:k3f9q8a1", logs)).toMatchObject({
      ok: true,
      subject: "k3f9q8a1",
    });
    expect(await resolveQualifiedId("platform:zzzz9999", logs)).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("serves a pinned 64-character sha without the network", async () => {
    const { src, main, head } = await setup();
    const s = source({ url: src.root, ref: head });
    expect((await readSources(main.git, [s], { fetch: "network" }))[0]?.status.fetched).toBe(true);
    await rename(src.root, `${src.root}.moved`);
    const trace = join(dirname(main.root), "trace.json");
    const [again] = await readSources(await traced(main, trace), [s], { fetch: "network" });
    expect(again?.status).toMatchObject({ commit: head, fetched: false });
    expect(again?.source?.stale).toBe(false);
    const commands = await tracedCommands(trace);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => ["fetch", "ls-remote", "upload-pack"].includes(c))).toEqual([]);
  });

  it("recreates a pinned SHA-1 cache when its url now serves a SHA-256 repository", async () => {
    const { src, main, head } = await setup();
    const old = await repo({ objectFormat: "sha1", files: { "docs/adr/README.md": "old\n" } });
    const s = source({ url: old.root });
    const f = await fetchSource(main.git, s);
    expect(f.commit).toHaveLength(40);
    await rename(old.root, `${old.root}.sha1`);
    await rename(src.root, old.root);
    const g = await fetchSource(main.git, s);
    expect(g).toMatchObject({ commit: head, stale: false, cacheDir: f.cacheDir });
    expect(await (await Git.openGitDir(g.cacheDir, main.git.options)).objectFormat()).toBe(
      "sha256",
    );
    expect(await readme(g.tree)).toBe("v1\n");
  });

  it("recreates an unpinned SHA-1 cache at a 64-character ref's path before fetching", async () => {
    const { src, main, head } = await setup();
    const url = join(dirname(main.root), "later");
    const s = source({ url, ref: head });
    await expect(fetchSource(main.git, s)).rejects.toBeInstanceOf(SourceFetchError);
    const sources = join(main.git.commonDir, "ark", "sources");
    const [name] = (await readdir(sources)).filter((n) => n.endsWith(".git"));
    const cacheDir = join(sources, name ?? "");
    // What a failed SHA-256 fetch left behind before caches took their source's format.
    await rm(cacheDir, { recursive: true, force: true });
    const leftover = await Git.initBare(cacheDir, main.git.options, { objectFormat: "sha1" });
    expect(await leftover.objectFormat()).toBe("sha1");
    await rename(src.root, url);
    const f = await fetchSource(main.git, s);
    expect(f).toMatchObject({ commit: head, stale: false, cacheDir });
    expect(await (await Git.openGitDir(cacheDir, main.git.options)).objectFormat()).toBe("sha256");
  });
});

describe("fetchSource with SHA-1 sources", () => {
  it("reuses a SHA-1 cache with one fetch and no probe", async () => {
    const { main } = await setup();
    const sha1 = await repo({ objectFormat: "sha1", files: { "docs/adr/README.md": "v1\n" } });
    const s = source({ url: sha1.root });
    const f = await fetchSource(main.git, s);
    const marker = join(f.cacheDir, "marker");
    await writeFile(marker, "kept\n");
    const trace = join(dirname(main.root), "trace.json");
    const g = await fetchSource(await traced(main, trace), s);
    expect(g).toMatchObject({ commit: f.commit, stale: false, cacheDir: f.cacheDir });
    expect(await readFile(marker, "utf8")).toBe("kept\n");
    const commands = await tracedCommands(trace);
    expect(commands.filter((c) => c === "fetch")).toEqual(["fetch"]);
    expect(commands.filter((c) => c === "ls-remote" || c === "init")).toEqual([]);
  });

  it("doesn't probe the source after a fetch times out", async () => {
    const { main } = await setup();
    const sha1 = await repo({ objectFormat: "sha1", files: { "docs/adr/README.md": "v1\n" } });
    const log = join(dirname(main.root), "spawns.log");
    const binary = join(dirname(main.root), "git-hanging-fetch");
    await writeFile(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LOG"\nfor a in "$@"; do [ "$a" = fetch ] && exec sleep 10; done\nexec '${realGit()}' "$@"\n`,
    );
    await chmod(binary, 0o755);
    const git = await Git.open(main.root, {
      ...main.git.options,
      binary,
      env: { ...main.git.options.env, LOG: log },
    });
    const started = Date.now();
    await expect(
      fetchSource(git, source({ url: sha1.root }), { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(SourceFetchError);
    expect(Date.now() - started).toBeLessThan(5300);
    const lines = (await readFile(log, "utf8")).split("\n");
    expect(lines.some((l) => l.includes("fetch"))).toBe(true);
    expect(lines.filter((l) => l.includes("ls-remote"))).toEqual([]);
  });
});
