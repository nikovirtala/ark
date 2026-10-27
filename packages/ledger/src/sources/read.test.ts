import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceFetchError } from "../errors.js";
import { Git } from "../git/git.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { SourceConfig } from "./config.js";
import { readSources, type SourceStatus, sourceFindings, sourcesOfKinds } from "./read.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

/** A source repository with a branch, an annotated tag and two commits, pushed to a bare remote. */
async function setup() {
  const src = await repo({ files: { "docs/adr/README.md": "v1\n" } });
  const first = (await src.git.resolveCommit("HEAD")) ?? "";
  await src.git.run(["tag", "-a", "v1", "-m", "v1"]);
  await src.write("docs/adr/README.md", "v2\n");
  const second = await src.commit("v2", { all: true });
  const remote = await repo({ bare: true });
  await src.git.run(["push", "-q", remote.root, "main", "v1"]);
  const main = await repo({ files: { "a.txt": "a\n" } });
  return { src, remote, main, first, second };
}

function source(o: Partial<SourceConfig> & { url: string }): SourceConfig {
  return { name: "platform", kind: "adr", ref: "main", root: null, ...o };
}

/** The git child commands a trace2 event file records, by their first argument after `git`. */
async function tracedCommands(file: string): Promise<string[]> {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { event: string; argv?: string[] })
    .filter((e) => e.event === "start" || e.event === "child_start")
    .flatMap((e) => (e.argv ?? []).filter((a) => !a.startsWith("-") && a !== "git").slice(0, 1));
}

describe("readSources", () => {
  it("reads only the cache by default: a miss is null, and nothing touches the network", async () => {
    const { remote, main } = await setup();
    const trace = join(main.root, "..", "trace.json");
    const git = await Git.open(main.root, {
      ...main.git.options,
      env: { ...main.git.options.env, GIT_TRACE2_EVENT: trace },
    });
    const s = source({ url: remote.root });
    const [read] = await readSources(git, [s], { fetch: "cache" });
    expect(read).toEqual({
      config: s,
      status: { name: "platform", kind: "adr", ref: "main", commit: null, fetched: false },
      source: null,
    });
    const commands = await tracedCommands(trace);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => /^(fetch|ls-remote|remote-)/.test(c))).toEqual([]);
  });

  it("fetches in network mode and serves the pin from the cache afterwards", async () => {
    const { remote, main, second } = await setup();
    const s = source({ url: remote.root });
    const [net] = await readSources(main.git, [s], { fetch: "network" });
    expect(net?.status).toEqual({
      name: "platform",
      kind: "adr",
      ref: "main",
      commit: second,
      fetched: true,
    });
    const [cached] = await readSources(main.git, [s], { fetch: "cache" });
    expect(cached?.status).toMatchObject({ commit: second, fetched: false });
    expect(cached?.source?.commit).toBe(second);
  });

  it("throws when a network fetch fails, naming the old pin if there is one", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const [net] = await readSources(main.git, [s], { fetch: "network" });
    const moved = `${remote.root}.moved`;
    await rename(remote.root, moved);
    const e = await readSources(main.git, [s], { fetch: "network" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SourceFetchError);
    expect((e as Error).message).toMatch(
      new RegExp(
        `^cannot fetch source platform \\(main\\): .+; the cache still pins ${net?.status.commit?.slice(0, 12)}$`,
      ),
    );
    // The cache still serves the old pin offline.
    const [cached] = await readSources(main.git, [s], { fetch: "cache" });
    expect(cached?.status.commit).toBe(net?.status.commit);
    await rename(moved, remote.root);
  });

  it("throws for a never-cached source whose url is missing", async () => {
    const { main } = await setup();
    const s = source({ url: join(main.root, "..", "nowhere.git") });
    const e = await readSources(main.git, [s], { fetch: "network" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SourceFetchError);
    expect((e as Error).message).toMatch(/^cannot fetch source platform \(main\): /);
    expect((e as Error).message).not.toContain("exited with");
  });

  it("pins the right commit for branch, full ref, annotated tag and full sha refs", async () => {
    const { remote, main, first, second } = await setup();
    for (const [ref, want] of [
      ["main", second],
      ["refs/heads/main", second],
      ["v1", first],
      [first, first],
    ] as const) {
      const [r] = await readSources(main.git, [source({ url: remote.root, ref })], {
        fetch: "network",
      });
      expect([ref, r?.status.commit]).toEqual([ref, want]);
    }
  });

  it("serves a pinned full sha without the network, even with the remote gone", async () => {
    const { remote, main, first } = await setup();
    const s = source({ url: remote.root, ref: first });
    expect((await readSources(main.git, [s], { fetch: "network" }))[0]?.status.fetched).toBe(true);
    await rename(remote.root, `${remote.root}.moved`);
    const [again] = await readSources(main.git, [s], { fetch: "network" });
    expect(again?.status).toMatchObject({ commit: first, fetched: false });
    await rename(`${remote.root}.moved`, remote.root);
  });

  it("keeps earlier sources' pins when a later one fails", async () => {
    const { remote, main, second } = await setup();
    const ok = source({ url: remote.root });
    const bad = source({ name: "gone", url: join(main.root, "..", "nowhere.git") });
    await expect(readSources(main.git, [ok, bad], { fetch: "network" })).rejects.toThrow(
      /cannot fetch source gone/,
    );
    const [cached] = await readSources(main.git, [ok], { fetch: "cache" });
    expect(cached?.status.commit).toBe(second);
  });
});

describe("sourcesOfKinds", () => {
  it("keeps the entries of the given kinds, in config order", () => {
    const a = source({ name: "a", kind: "adr", url: "u" });
    const b = source({ name: "b", kind: "issues", url: "u" });
    const c = source({ name: "c", kind: "adr", url: "u" });
    expect(sourcesOfKinds([a, b, c], ["adr"])).toEqual([a, c]);
    expect(sourcesOfKinds([a, b, c], ["issues", "adr"])).toEqual([a, b, c]);
    expect(sourcesOfKinds([a, b, c], [])).toEqual([]);
  });
});

describe("sourceFindings", () => {
  const status = (name: string, commit: string | null): SourceStatus => ({
    name,
    kind: "issues",
    ref: "main",
    commit,
    fetched: false,
  });

  it("warns once per referenced uncached source, on the config file", () => {
    const fs = sourceFindings([status("a", null), status("b", null), status("c", "f".repeat(40))], {
      tool: "issues",
      file: "docs/issues/issues.toml",
      referenced: new Set(["a", "c"]),
    });
    expect(fs).toEqual([
      {
        severity: "warning",
        rule: "sources/not-fetched",
        message:
          "a not fetched; references not checked. Run issues sources fetch, or verify with --fetch-sources",
        file: "docs/issues/issues.toml",
        line: null,
        subject: null,
        kind: null,
      },
    ]);
  });
});
