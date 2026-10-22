import { chmod, copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitError,
  GitNotFoundError,
  GitVersionError,
  InvalidArgumentError,
  NotARepositoryError,
} from "../errors.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { GIT_ENV_ISOLATION, GIT_LOCATING_ENV, Git } from "./git.js";
import { indexReader, refReader, worktreeReader } from "./tree.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0)) await fn();
});

async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  cleanup.push(() => r.dispose());
  return r;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A script standing in for git: `version` prints `versionLine`, anything else runs `body`. */
async function fakeGit(versionLine: string, body = 'exec git "$@"'): Promise<string> {
  const path = join(await tempDir(), "git");
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = version ]; then echo "${versionLine}"; exit 0; fi\n${body}\n`,
  );
  await chmod(path, 0o755);
  return path;
}

describe("Git.open", () => {
  it("opens a work tree with absolute root, gitDir and commonDir", async () => {
    const r = await repo();
    const git = await Git.open(join(r.root));
    expect(git.root).toBe(r.root);
    expect(git.gitDir).toBe(join(r.root, ".git"));
    expect(git.commonDir).toBe(join(r.root, ".git"));
  });

  it("throws NotARepositoryError outside a repository, in a bare one and for a missing dir", async () => {
    const dir = await tempDir();
    await expect(Git.open(dir, { env: GIT_ENV_ISOLATION })).rejects.toBeInstanceOf(
      NotARepositoryError,
    );
    await expect(Git.open(join(dir, "missing"))).rejects.toBeInstanceOf(NotARepositoryError);
    const bare = await repo({ bare: true });
    await expect(Git.open(bare.root, { env: GIT_ENV_ISOLATION })).rejects.toBeInstanceOf(
      NotARepositoryError,
    );
  });

  it("throws GitNotFoundError for a missing binary", async () => {
    const r = await repo();
    const binary = join(await tempDir(), "no-such-git");
    const error = await Git.open(r.root, { binary }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitNotFoundError);
    expect(error).toMatchObject({ binary });
    expect((error as Error).cause).toBeInstanceOf(Error);
    await expect(Git.openGitDir(r.git.gitDir, { binary })).rejects.toBeInstanceOf(GitNotFoundError);
    await expect(Git.initBare(join(r.root, "x.git"), { binary })).rejects.toBeInstanceOf(
      GitNotFoundError,
    );
  });

  it("gates on git 2.32 per binary in open, openGitDir and initBare", async () => {
    const r = await repo();
    const binary = await fakeGit("git version 2.30.0");
    const error = await Git.open(r.root, { binary }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitVersionError);
    expect(error).toMatchObject({ found: "2.30.0", required: "2.32.0" });
    await expect(Git.openGitDir(r.git.gitDir, { binary })).rejects.toBeInstanceOf(GitVersionError);
    const target = join(await tempDir(), "new.git");
    await expect(Git.initBare(target, { binary })).rejects.toBeInstanceOf(GitVersionError);
    await expect(stat(target)).rejects.toThrow();
    // The real git still opens in the same process.
    await expect(Git.open(r.root)).resolves.toBeInstanceOf(Git);
  });

  it("accepts a new enough fake binary", async () => {
    const r = await repo();
    const git = await Git.open(r.root, { binary: await fakeGit("git version 2.32.0.windows.1") });
    expect(git.root).toBe(r.root);
  });
});

describe("Git.openGitDir and Git.initBare", () => {
  it("opens a bare repository with root null", async () => {
    const bare = await repo({ bare: true });
    const git = await Git.openGitDir(bare.root);
    expect(git.root).toBeNull();
    expect(git.gitDir).toBe(bare.root);
    expect(git.commonDir).toBe(bare.root);
  });

  it("opens a non-bare .git with root null and never writes into it", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const git = await Git.openGitDir(join(r.root, ".git"), { env: GIT_ENV_ISOLATION });
    expect(git.root).toBeNull();
    expect(git.gitDir).toBe(join(r.root, ".git"));
    expect(
      new TextDecoder().decode(
        (await (await refReader(git, "main")).read("a.txt")) ?? new Uint8Array(),
      ),
    ).toBe("a\n");
    const before = await readdir(git.gitDir);
    await writeFile(join(r.root, "b.txt"), "b\n");
    await expect(git.add(["b.txt"])).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(await readdir(git.gitDir)).toEqual(before);
    expect((await (await indexReader(r.git)).list("")).map((e) => e.path)).toEqual(["a.txt"]);
  });

  it("throws NotARepositoryError for a directory that isn't a git dir", async () => {
    await expect(Git.openGitDir(await tempDir())).rejects.toBeInstanceOf(NotARepositoryError);
  });

  it("refuses worktree-only operations on a git-dir handle before spawning git", async () => {
    const bare = await repo({ bare: true });
    const git = bare.git;
    expect(() => worktreeReader(git)).toThrow(InvalidArgumentError);
    await expect(indexReader(git)).rejects.toThrow("operation needs a work tree");
    await expect(git.add(["a"])).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(git.commit({ message: "m" })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("initBare creates a bare repository", async () => {
    const dir = join(await tempDir(), "nested", "cache.git");
    const git = await Git.initBare(dir, { env: GIT_ENV_ISOLATION });
    expect(git.root).toBeNull();
    expect(git.gitDir).toBe(dir);
    const out = await git.run(["rev-parse", "--is-bare-repository"]);
    expect(Buffer.from(out.stdout).toString()).toBe("true\n");
  });
});

describe("environment", () => {
  it("defines GIT_ENV_ISOLATION as every locating variable unset", () => {
    expect(Object.keys(GIT_ENV_ISOLATION).sort()).toEqual([...GIT_LOCATING_ENV].sort());
    expect(Object.values(GIT_ENV_ISOLATION).every((v) => v === undefined)).toBe(true);
  });

  it("lets the main Git inherit GIT_INDEX_FILE while an isolated Git ignores it", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const alt = join(r.root, ".git", "alt-index");
    await copyFile(join(r.root, ".git", "index"), alt);
    await r.write("b.txt", "b\n");
    await r.git.run(["add", "b.txt"], { env: { GIT_INDEX_FILE: alt } });

    vi.stubEnv("GIT_INDEX_FILE", alt);
    const { GIT_INDEX_FILE: _, ...othersUnset } = GIT_ENV_ISOLATION;
    const inherited = await Git.open(r.root, { env: othersUnset });
    const isolated = await Git.open(r.root, { env: GIT_ENV_ISOLATION });
    const paths = async (git: Git) => (await (await indexReader(git)).list("")).map((e) => e.path);
    expect(await paths(inherited)).toEqual(["a.txt", "b.txt"]);
    expect(await paths(isolated)).toEqual(["a.txt"]);
    expect(await paths(r.git)).toEqual(["a.txt"]);
  });

  it("ignores an outer GIT_DIR when isolated", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const bogus = join(await tempDir(), "bogus.git");
    vi.stubEnv("GIT_DIR", bogus);
    vi.stubEnv("GIT_INDEX_FILE", join(bogus, "index"));
    const isolated = await Git.open(r.root, { env: GIT_ENV_ISOLATION });
    expect(isolated.gitDir).toBe(join(r.root, ".git"));
    expect((await (await indexReader(isolated)).list("")).map((e) => e.path)).toEqual(["a.txt"]);
    const other = await createTempRepo({ files: { "c.txt": "c\n" } });
    cleanup.push(() => other.dispose());
    expect((await (await indexReader(other.git)).list("")).map((e) => e.path)).toEqual(["c.txt"]);
    await expect(stat(bogus)).rejects.toThrow();
  });

  it("drops undefined keys and sets GIT_OPTIONAL_LOCKS=0", async () => {
    const r = await repo();
    vi.stubEnv("LEDGER_TEST_VAR", "outer");
    const binary = await fakeGit(
      "git version 2.50.0",
      [
        'if [ -n "$LEDGER_ECHO" ]; then',
        "  v=unset; env | grep -q '^LEDGER_TEST_VAR=' && v=$LEDGER_TEST_VAR",
        '  echo "$v $GIT_OPTIONAL_LOCKS"; exit 0',
        "fi",
        'exec git "$@"',
      ].join("\n"),
    );
    const echo = async (git: Git, env: NodeJS.ProcessEnv) =>
      Buffer.from((await git.run(["status"], { env: { LEDGER_ECHO: "1", ...env } })).stdout)
        .toString()
        .trim();
    const inherits = await Git.open(r.root, { binary });
    expect(await echo(inherits, {})).toBe("outer 0");
    expect(await echo(inherits, { LEDGER_TEST_VAR: undefined })).toBe("unset 0");
    const unsets = await Git.open(r.root, { binary, env: { LEDGER_TEST_VAR: undefined } });
    expect(await echo(unsets, {})).toBe("unset 0");
    expect(await echo(unsets, { LEDGER_TEST_VAR: "call" })).toBe("call 0");
  });
});

describe("Git.run", () => {
  it("throws GitError with args, exit code and stderr outside okCodes", async () => {
    const r = await repo();
    const error = await r.git.run(["rev-parse", "--verify", "nope"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({
      code: "git-failed",
      args: ["rev-parse", "--verify", "nope"],
      exitCode: 128,
    });
    expect((error as GitError).stderr).toMatch(/fatal/);
    const ok = await r.git.run(["rev-parse", "--verify", "nope"], { okCodes: [128] });
    expect(ok.code).toBe(128);
  });

  it("kills git and throws a git-timeout GitError after timeoutMs", async () => {
    const r = await repo();
    const binary = await fakeGit(
      "git version 2.50.0",
      'if [ -n "$LEDGER_SLEEP" ]; then exec sleep 5; fi\nexec git "$@"',
    );
    const git = await Git.open(r.root, { binary });
    const error = await git
      .run(["status"], { timeoutMs: 100, env: { LEDGER_SLEEP: "1" } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ code: "git-timeout", exitCode: null });
  });

  it("passes input on stdin and returns stdout bytes", async () => {
    const r = await repo();
    const out = await r.git.run(["hash-object", "--stdin"], { input: "hello\n" });
    expect(Buffer.from(out.stdout).toString().trim()).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });
});

describe("revisions and paths", () => {
  it("resolveCommit returns a sha, or null for unknown refs and an unborn HEAD", async () => {
    const unborn = await repo();
    expect(await unborn.git.resolveCommit("HEAD")).toBeNull();
    const r = await repo({ files: { "a.txt": "a\n" } });
    expect(await r.git.resolveCommit("HEAD")).toMatch(/^[0-9a-f]{40}$/);
    expect(await r.git.resolveCommit("main")).toBe(await r.git.resolveCommit("HEAD"));
    expect(await r.git.resolveCommit("nope")).toBeNull();
  });

  it("rejects option-like or NUL-containing revs and paths", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    await expect(r.git.resolveCommit("-x")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(r.git.resolveCommit("ma\0in")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(r.git.add(["--all"])).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(r.git.add(["a\0b"])).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(r.git.mergeBase("main", "--all")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("mergeBase finds the fork point, or null", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const base = await r.git.resolveCommit("HEAD");
    await r.checkout("topic", { create: true });
    await r.write("b.txt", "b\n");
    await r.stage("b.txt");
    const topic = await r.commit("b");
    expect(await r.git.mergeBase("main", topic)).toBe(base);
    expect(await r.git.mergeBase("main", "nope")).toBeNull();
    await r.git.run(["checkout", "-q", "--orphan", "lonely"]);
    const lonely = await r.commit("lonely", { allowEmpty: true });
    expect(await r.git.mergeBase("main", lonely)).toBeNull();
  });

  it("reports shallow and object format", async () => {
    const r = await repo();
    expect(await r.git.isShallow()).toBe(false);
    expect(await r.git.objectFormat()).toBe("sha1");
    const s = await repo({ objectFormat: "sha256" });
    expect(await s.git.objectFormat()).toBe("sha256");
  });
});

describe("commit, trailers and blobs", () => {
  it("keeps a #42 line in the message", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.stage("a.txt");
    const message = "fix: handle the thing\n\n#42 follow-up\n# Heading\n";
    const sha = await r.git.commit({ message });
    const out = await r.git.run(["log", "-1", "--format=%B", sha]);
    expect(Buffer.from(out.stdout).toString()).toBe(`${message}\n`);
  });

  it("validates trailer keys and values", async () => {
    const r = await repo();
    await expect(
      r.git.commit({ message: "m", allowEmpty: true, trailers: [["Bad Key", "v"]] }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      r.git.commit({ message: "m", allowEmpty: true, trailers: [["ADR", "1\n2"]] }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      r.git.commit({ message: "m", allowEmpty: true, trailers: [["ADR", "12"]] }),
    ).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("appendTrailers adds trailers to a message file once", async () => {
    const r = await repo();
    const file = join(r.root, ".git", "COMMIT_EDITMSG");
    await writeFile(file, "feat: x\n\nbody\n");
    await r.git.appendTrailers(file, [["Issue", "m4p8x2kd"]]);
    await r.git.appendTrailers(file, [
      ["Issue", "m4p8x2kd"],
      ["ADR-Event", "accepted"],
    ]);
    expect(await readFile(file, "utf8")).toBe(
      "feat: x\n\nbody\n\nIssue: m4p8x2kd\nADR-Event: accepted\n",
    );
  });

  it("readBlobs reads by oid and leaves missing objects out", async () => {
    const r = await repo({ files: { "a.txt": "a\n", "b.bin": "\0\x01\n" } });
    const entries = await (await refReader(r.git, "HEAD")).list("");
    const oids = entries.map((e) => e.oid ?? "");
    const missing = "0".repeat(40);
    const blobs = await r.git.readBlobs([...oids, missing, ...oids]);
    expect([...blobs.keys()].sort()).toEqual([...oids].sort());
    expect(Buffer.from(blobs.get(oids[1] ?? "") ?? []).toString()).toBe("\0\x01\n");
    await expect(r.git.readBlobs(["HEAD"])).rejects.toBeInstanceOf(InvalidArgumentError);
    expect((await r.git.readBlobs([])).size).toBe(0);
  });
});
