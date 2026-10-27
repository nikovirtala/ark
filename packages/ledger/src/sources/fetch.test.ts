import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceFetchError } from "../errors.js";
import { GIT_ENV_ISOLATION, Git } from "../git/git.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { SourceConfig } from "./config.js";
import { acquireLock, fetchSource, type LockDeps } from "./fetch.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

const text = new TextDecoder();

/** A source repository, the bare "remote" it pushes to, and the repository that fetches it. */
async function setup() {
  const src = await repo({ files: { "docs/adr/README.md": "v1\n" } });
  const remote = await repo({ bare: true });
  const main = await repo({ files: { "a.txt": "a\n" } });
  const push = async (...refs: string[]) => {
    await src.git.run(["push", "-q", remote.root, ...refs]);
  };
  const update = async (content: string) => {
    await src.write("docs/adr/README.md", content);
    return src.commit(content.trim(), { all: true });
  };
  await push("main");
  return { src, remote, main, push, update };
}

function source(o: Partial<SourceConfig> & { url: string }): SourceConfig {
  return { name: "platform", kind: "adr", ref: "main", root: null, ...o };
}

async function readme(tree: { read(p: string): Promise<Uint8Array | null> }) {
  const bytes = await tree.read("docs/adr/README.md");
  return bytes === null ? null : text.decode(bytes);
}

describe("fetchSource", () => {
  it("fetches a branch into a bare cache keyed by url and ref", async () => {
    const { src, remote, main, update, push } = await setup();
    const f = await fetchSource(main.git, source({ url: remote.root }));
    expect(f.commit).toBe(await src.git.resolveCommit("HEAD"));
    expect(f.stale).toBe(false);
    expect(await readme(f.tree)).toBe("v1\n");
    expect(f.tree.label).toBe(`refs/ark/pinned (${f.commit.slice(0, 7)})`);
    expect(f.cacheDir).toMatch(/\/ark\/sources\/platform-[0-9a-f]{12}\.git$/);
    expect(f.cacheDir.startsWith(join(main.git.commonDir, "ark", "sources"))).toBe(true);
    const metadata = JSON.parse(readFileSync(join(f.cacheDir, "ark-source.json"), "utf8"));
    expect(metadata).toMatchObject({
      name: "platform",
      url: remote.root,
      ref: "main",
      commit: f.commit,
    });
    expect(existsSync(`${f.cacheDir}.lock`)).toBe(false);
    expect(await main.git.isShallow()).toBe(false);

    const next = await update("v2\n");
    await push("main");
    const g = await fetchSource(main.git, source({ url: remote.root }));
    expect(g).toMatchObject({ commit: next, stale: false, cacheDir: f.cacheDir });
    expect(await readme(g.tree)).toBe("v2\n");
  });

  it("fetches an annotated tag and a full commit sha", async () => {
    const { src, remote, main, push, update } = await setup();
    const tagged = await src.git.resolveCommit("HEAD");
    await src.git.run(["tag", "-a", "v1", "-m", "release v1"]);
    await update("v2\n");
    await push("main", "refs/tags/v1");

    const byTag = await fetchSource(main.git, source({ url: remote.root, ref: "v1" }));
    expect(byTag.commit).toBe(tagged);
    expect(await readme(byTag.tree)).toBe("v1\n");

    const sha = tagged ?? "";
    const bySha = await fetchSource(main.git, source({ url: remote.root, ref: sha }));
    expect(bySha.commit).toBe(sha);
    expect(await readme(bySha.tree)).toBe("v1\n");
    expect(new Set([byTag.cacheDir, bySha.cacheDir]).size).toBe(2);

    // A pinned full sha is immutable: no fetch, so a missing remote doesn't make it stale.
    await rm(remote.root, { recursive: true, force: true });
    expect(await fetchSource(main.git, source({ url: remote.root, ref: sha }))).toMatchObject({
      commit: sha,
      stale: false,
    });
  });

  it("serves the cache offline and fails offline without one", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    await expect(fetchSource(main.git, s, { offline: true })).rejects.toBeInstanceOf(
      SourceFetchError,
    );
    const f = await fetchSource(main.git, s);
    await rm(remote.root, { recursive: true, force: true });
    const g = await fetchSource(main.git, s, { offline: true });
    expect(g).toMatchObject({ commit: f.commit, stale: false, cacheDir: f.cacheDir });
    expect(await readme(g.tree)).toBe("v1\n");
  });

  it("serves the pinned commit as stale when a refetch fails", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const f = await fetchSource(main.git, s);
    await rm(remote.root, { recursive: true, force: true });
    const g = await fetchSource(main.git, s);
    expect(g).toMatchObject({ commit: f.commit, stale: true, cacheDir: f.cacheDir });
    expect(g.staleReason).toMatch(/^fatal: /);
    expect(f.staleReason).toBeNull();
    expect(await readme(g.tree)).toBe("v1\n");
  });

  it("throws SourceFetchError when a fetch fails and nothing is cached", async () => {
    const { remote, main } = await setup();
    const e = await fetchSource(main.git, source({ url: remote.root, ref: "nope" })).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(SourceFetchError);
    expect(e).toMatchObject({ code: "source-fetch", source: "platform" });
    expect((e as SourceFetchError).stderr).toContain("nope");
    // git's first stderr line, not the GitError's "git -c exited with 128" message.
    expect((e as SourceFetchError).message).toBe(
      "cannot fetch source platform (nope): fatal: couldn't find remote ref nope",
    );
  });

  it("uses a new cache when the ref or url changes, and leaves the old one alone", async () => {
    const { src, remote, main, push } = await setup();
    await src.checkout("next", { create: true });
    await src.write("docs/adr/README.md", "next\n");
    const nextSha = await src.commit("next", { all: true });
    await push("next");
    const other = await repo({ bare: true });
    await src.git.run(["push", "-q", other.root, "next:main"]);

    const onMain = await fetchSource(main.git, source({ url: remote.root }));
    const onNext = await fetchSource(main.git, source({ url: remote.root, ref: "next" }));
    const otherUrl = await fetchSource(main.git, source({ url: other.root }));
    expect(new Set([onMain.cacheDir, onNext.cacheDir, otherUrl.cacheDir]).size).toBe(3);
    expect(onNext.commit).toBe(nextSha);
    expect(otherUrl.commit).toBe(nextSha);

    await rm(remote.root, { recursive: true, force: true });
    await rm(other.root, { recursive: true, force: true });
    const offline = { offline: true };
    expect(
      await readme((await fetchSource(main.git, source({ url: remote.root }), offline)).tree),
    ).toBe("v1\n");
    expect(
      await readme((await fetchSource(main.git, source({ url: other.root }), offline)).tree),
    ).toBe("next\n");
  });

  it("lets two concurrent fetches of one source both succeed", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const [a, b] = await Promise.all([fetchSource(main.git, s), fetchSource(main.git, s)]);
    expect(a.commit).toBe(b.commit);
    expect(a.cacheDir).toBe(b.cacheDir);
    expect(a.stale || b.stale).toBe(false);
  });

  it("times out on a lock another process holds", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const { cacheDir } = await fetchSource(main.git, s);
    await writeFile(`${cacheDir}.lock`, "");
    const started = Date.now();
    await expect(fetchSource(main.git, s, { timeoutMs: 300 })).rejects.toThrow(
      `source cache is locked by another process: ${cacheDir}.lock`,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(existsSync(`${cacheDir}.lock`)).toBe(true);
  });

  it("reclaims a stale lock", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const { cacheDir } = await fetchSource(main.git, s);
    await writeFile(`${cacheDir}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${cacheDir}.lock`, old, old);
    expect((await fetchSource(main.git, s, { timeoutMs: 10_000 })).stale).toBe(false);
    expect(existsSync(`${cacheDir}.lock`)).toBe(false);
  });

  it("never takes over a live lock whose holder has a longer budget", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const { cacheDir } = await fetchSource(main.git, s);
    const held = JSON.stringify({ pid: 1, token: "held", expiresAt: Date.now() + 60_000 });
    await writeFile(`${cacheDir}.lock`, held);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${cacheDir}.lock`, old, old);
    await expect(fetchSource(main.git, s, { timeoutMs: 300 })).rejects.toThrow(
      `source cache is locked by another process: ${cacheDir}.lock`,
    );
    expect(await readFile(`${cacheDir}.lock`, "utf8")).toBe(held);
  });

  it("reclaims at once a lock whose holder on this host has exited", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const { cacheDir } = await fetchSource(main.git, s);
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    const dead = { pid, hostname: hostname(), token: "dead", expiresAt: Date.now() + 60_000 };
    await writeFile(`${cacheDir}.lock`, JSON.stringify(dead));
    const started = Date.now();
    expect((await fetchSource(main.git, s, { timeoutMs: 10_000 })).stale).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(`${cacheDir}.lock`)).toBe(false);
  });

  it("reclaims a lock whose holder's recorded budget ran out", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const { cacheDir } = await fetchSource(main.git, s);
    const expired = JSON.stringify({ pid: 1, token: "gone", expiresAt: Date.now() - 1_000 });
    await writeFile(`${cacheDir}.lock`, expired);
    expect((await fetchSource(main.git, s, { timeoutMs: 10_000 })).stale).toBe(false);
    expect(existsSync(`${cacheDir}.lock`)).toBe(false);
  });

  it("leaves a lock it no longer owns when it finishes", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const { cacheDir } = await fetchSource(main.git, s);
    const lockPath = `${cacheDir}.lock`;
    // Stands in for another process reclaiming the lock while this fetch runs.
    const binary = join(dirname(main.root), "git-swapping-lock");
    await writeFile(
      binary,
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = fetch ] && printf other > "$SWAP_LOCK"; done\nexec git "$@"\n`,
    );
    await chmod(binary, 0o755);
    const git = await Git.open(main.root, {
      ...main.git.options,
      binary,
      env: { ...main.git.options.env, SWAP_LOCK: lockPath },
    });
    expect((await fetchSource(git, s)).stale).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe("other");
  });

  it("rebuilds a cache directory that isn't a repository", async () => {
    const { remote, main } = await setup();
    const s = source({ url: remote.root });
    const f = await fetchSource(main.git, s);
    await rm(f.cacheDir, { recursive: true, force: true });
    await mkdir(f.cacheDir);
    await writeFile(join(f.cacheDir, "HEAD"), "garbage\n");
    await expect(fetchSource(main.git, s, { offline: true })).rejects.toBeInstanceOf(
      SourceFetchError,
    );
    const g = await fetchSource(main.git, s);
    expect(g).toMatchObject({ commit: f.commit, stale: false, cacheDir: f.cacheDir });
    expect(await readme(g.tree)).toBe("v1\n");
  });

  it("resolves a local url against the calling repository, bare or not", async () => {
    const { remote, main } = await setup();
    const f = await fetchSource(main.git, source({ url: relative(main.root, remote.root) }));
    expect(await readme(f.tree)).toBe("v1\n");

    const gitDirOnly = await Git.openGitDir(main.git.gitDir, main.git.options);
    const g = await fetchSource(
      gitDirOnly,
      source({ url: relative(gitDirOnly.gitDir, remote.root) }),
    );
    expect(g.commit).toBe(f.commit);
  });

  it("never lets the caller's locating variables reach the cache", async () => {
    const { remote, main } = await setup();
    // Without isolation the fetch would write its objects into the main repository's object store.
    vi.stubEnv("GIT_OBJECT_DIRECTORY", join(main.git.commonDir, "objects"));
    vi.stubEnv("GIT_INDEX_FILE", join(main.git.gitDir, "index"));
    const callerOpts = { env: { ...main.git.options.env } };
    for (const k of ["GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE"]) delete callerOpts.env[k];
    const caller = await Git.open(main.root, callerOpts);
    const f = await fetchSource(caller, source({ url: remote.root }));
    vi.unstubAllEnvs();
    const cache = await Git.openGitDir(f.cacheDir, { env: GIT_ENV_ISOLATION });
    expect((await cache.run(["cat-file", "-e", f.commit], { okCodes: [0, 1, 128] })).code).toBe(0);
    expect(await main.git.resolveCommit(f.commit)).toBeNull();
    expect(await main.git.isShallow()).toBe(false);
  });
});

describe("acquireLock", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function lockIn(): Promise<{ dir: string; lock: string }> {
    const dir = await mkdtemp(join(tmpdir(), "ark-lock-"));
    dirs.push(dir);
    return { dir, lock: join(dir, "cache.git.lock") };
  }

  /** A fake clock that only moves when a caller sleeps, shared by every caller using it. */
  function clock() {
    return { t: 1_800_000_000_000, sleeps: [] as number[] };
  }
  function fakeDeps(c: ReturnType<typeof clock>, o: Partial<LockDeps> = {}): Partial<LockDeps> {
    return {
      now: () => c.t,
      sleep: async (ms) => {
        c.t += ms;
        c.sleeps.push(ms);
        await new Promise((r) => setImmediate(r));
      },
      kill: () => {},
      hostname: () => "this-host",
      pid: 101,
      ...o,
    };
  }
  const errno = (code: string) => Object.assign(new Error(code), { code });
  function gate() {
    let open = () => {};
    const opened = new Promise<void>((r) => {
      open = r;
    });
    return { opened, open };
  }

  it("reclaims at once a lock whose holder on this host has exited", async () => {
    const { dir, lock } = await lockIn();
    const c = clock();
    const kill = vi.fn(() => {
      throw errno("ESRCH");
    });
    const dead = { pid: 999999, hostname: "this-host", token: "dead", expiresAt: c.t + 60_000 };
    await writeFile(lock, JSON.stringify(dead));
    const release = await acquireLock(lock, "s", 10_000, fakeDeps(c, { kill }));
    expect(c.sleeps).toHaveLength(0);
    expect(kill).toHaveBeenCalledWith(999999, 0);
    const own = JSON.parse(await readFile(lock, "utf8"));
    expect(own).toMatchObject({ pid: 101, hostname: "this-host" });
    expect(own.token).toMatch(/^[0-9a-f]{16}$/);
    await release();
    expect(await readdir(dir)).toEqual([]);
  });

  it("notices while polling that the holder's budget ran out", async () => {
    const { lock } = await lockIn();
    const c = clock();
    const kill = vi.fn();
    const late = { pid: 7, hostname: "other-host", token: "late", expiresAt: c.t + 250 };
    await writeFile(lock, JSON.stringify(late));
    const release = await acquireLock(lock, "s", 10_000, fakeDeps(c, { kill }));
    expect(c.sleeps).toHaveLength(3);
    expect(kill).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: 101 });
    await release();
  });

  it("treats a holder it may not signal (EPERM) as alive", async () => {
    const { lock } = await lockIn();
    const c = clock();
    const held = JSON.stringify({
      pid: 4242,
      hostname: "this-host",
      token: "held",
      expiresAt: c.t + 60_000,
    });
    await writeFile(lock, held);
    const kill = () => {
      throw errno("EPERM");
    };
    await expect(acquireLock(lock, "s", 300, fakeDeps(c, { kill }))).rejects.toThrow(
      `source cache is locked by another process: ${lock}`,
    );
    expect(await readFile(lock, "utf8")).toBe(held);
    expect(c.sleeps).toHaveLength(3);
  });

  it("never checks the pid of a holder on another host", async () => {
    const { lock } = await lockIn();
    const c = clock();
    const kill = vi.fn(() => {
      throw errno("ESRCH");
    });
    const held = { pid: 4242, hostname: "other-host", token: "held", expiresAt: c.t + 60_000 };
    await writeFile(lock, JSON.stringify(held));
    await expect(acquireLock(lock, "s", 300, fakeDeps(c, { kill }))).rejects.toThrow(
      `source cache is locked by another process: ${lock}`,
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("retries at once when another caller reclaimed the stale lock first", async () => {
    const { lock } = await lockIn();
    const c = clock();
    const expired = { pid: 7, hostname: "other-host", token: "gone", expiresAt: c.t - 1 };
    await writeFile(lock, JSON.stringify(expired));
    const beforeReclaim = async (p: string) => {
      await rm(p);
    };
    const release = await acquireLock(lock, "s", 10_000, fakeDeps(c, { beforeReclaim }));
    expect(c.sleeps).toHaveLength(0);
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: 101 });
    await release();
  });

  it("leaves exactly one holder when two callers reclaim the same stale lock", async () => {
    const { dir, lock } = await lockIn();
    const c = clock();
    const expired = { pid: 7, hostname: "other-host", token: "gone", expiresAt: c.t - 1 };
    await writeFile(lock, JSON.stringify(expired));
    const arrivedA = gate();
    const arrivedB = gate();
    const goA = gate();
    const goB = gate();
    const bSlept = gate();
    const resume = gate();
    const pA = acquireLock(
      lock,
      "s",
      10_000,
      fakeDeps(c, {
        pid: 101,
        beforeReclaim: async () => {
          arrivedA.open();
          await goA.opened;
        },
      }),
    );
    const pB = acquireLock(
      lock,
      "s",
      10_000,
      fakeDeps(c, {
        pid: 102,
        beforeReclaim: async () => {
          arrivedB.open();
          await goB.opened;
        },
        sleep: async () => {
          bSlept.open();
          await resume.opened;
        },
      }),
    );
    // Both callers have judged the expired lock stale.
    await Promise.all([arrivedA.opened, arrivedB.opened]);

    goA.open();
    const releaseA = await pA;
    const lockA = await readFile(lock, "utf8");
    expect(JSON.parse(lockA)).toMatchObject({ pid: 101 });

    // B now moves A's live lock aside, finds it isn't the lock it judged, and puts it back.
    goB.open();
    await bSlept.opened;
    expect(await readFile(lock, "utf8")).toBe(lockA);
    expect(await readdir(dir)).toEqual(["cache.git.lock"]);

    await releaseA();
    resume.open();
    const releaseB = await pB;
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ pid: 102 });
    await releaseB();
    expect(await readdir(dir)).toEqual([]);
  });

  it("gives way to a lock created while a moved lock was being put back", async () => {
    const { dir, lock } = await lockIn();
    const c = clock();
    const expired = { pid: 7, hostname: "other-host", token: "gone", expiresAt: c.t - 1 };
    await writeFile(lock, JSON.stringify(expired));
    const arrivedA = gate();
    const arrivedB = gate();
    const goA = gate();
    const goB = gate();
    const third = JSON.stringify({
      pid: 303,
      hostname: "other-host",
      token: "third",
      expiresAt: c.t + 60_000,
    });
    const pA = acquireLock(
      lock,
      "s",
      300,
      fakeDeps(c, {
        pid: 101,
        beforeReclaim: async () => {
          arrivedA.open();
          await goA.opened;
        },
      }),
    );
    const pB = acquireLock(
      lock,
      "s",
      300,
      fakeDeps(c, {
        pid: 102,
        beforeReclaim: async () => {
          arrivedB.open();
          await goB.opened;
        },
        beforeRestore: async (p) => {
          await writeFile(p, third, { flag: "wx" });
        },
      }),
    );
    await Promise.all([arrivedA.opened, arrivedB.opened]);
    goA.open();
    const releaseA = await pA;
    goB.open();
    await expect(pB).rejects.toThrow(`source cache is locked by another process: ${lock}`);
    expect(await readFile(lock, "utf8")).toBe(third);
    expect(await readdir(dir)).toEqual(["cache.git.lock"]);
    // A's lock was lost in the documented window; its release leaves the newer lock alone.
    await releaseA();
    expect(await readFile(lock, "utf8")).toBe(third);
  });
});
