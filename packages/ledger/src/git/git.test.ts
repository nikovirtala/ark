import { chmod, copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitError,
  GitNotFoundError,
  GitVersionError,
  InvalidArgumentError,
  NotARepositoryError,
} from "../errors.js";
import { parseCommitTemplate, renderCommitMessage } from "../surfaces/commit-message.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  commitMessageText,
  GIT_ENV_ISOLATION,
  GIT_LOCATING_ENV,
  Git,
  type Trailer,
} from "./git.js";
import { firstParentHistory } from "./history.js";
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
    const git = await Git.open(join(r.root), { env: r.env });
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
    await expect(Git.open(r.root, { env: r.env })).resolves.toBeInstanceOf(Git);
  });

  it("accepts a new enough fake binary", async () => {
    const r = await repo();
    const git = await Git.open(r.root, {
      binary: await fakeGit("git version 2.32.0.windows.1"),
      env: r.env,
    });
    expect(git.root).toBe(r.root);
  });
});

describe("Git.openGitDir and Git.initBare", () => {
  it("opens a bare repository with root null", async () => {
    const bare = await repo({ bare: true });
    const git = await Git.openGitDir(bare.root, { env: bare.env });
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

  it("initBare creates the object format asked for, whatever GIT_DEFAULT_HASH says", async () => {
    const base = await tempDir();
    const env = { ...GIT_ENV_ISOLATION };
    const sha256 = await Git.initBare(join(base, "a.git"), { env }, { objectFormat: "sha256" });
    expect(await sha256.objectFormat()).toBe("sha256");
    const sha1 = await Git.initBare(
      join(base, "b.git"),
      { env: { ...env, GIT_DEFAULT_HASH: "sha256" } },
      { objectFormat: "sha1" },
    );
    expect(await sha1.objectFormat()).toBe("sha1");
    const plain = await Git.initBare(join(base, "c.git"), {
      env: { ...env, GIT_DEFAULT_HASH: undefined },
    });
    expect(await plain.objectFormat()).toBe("sha1");
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
    const inherits = await Git.open(r.root, { binary, env: r.env });
    expect(await echo(inherits, {})).toBe("outer 0");
    expect(await echo(inherits, { LEDGER_TEST_VAR: undefined })).toBe("unset 0");
    const unsets = await Git.open(r.root, {
      binary,
      env: { ...r.env, LEDGER_TEST_VAR: undefined },
    });
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
    const git = await Git.open(r.root, { binary, env: r.env });
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

  it("appendTrailers keeps repeated trailers with ifExists add, whatever trailer.* says", async () => {
    const r = await repo();
    for (const [k, v] of [
      ["trailer.ifexists", "replace"],
      ["trailer.ifmissing", "doNothing"],
      ["trailer.where", "start"],
    ] as const) {
      await r.git.run(["config", k, v]);
    }
    const file = join(r.root, ".git", "COMMIT_EDITMSG");
    const pairs: [string, string][] = [
      ["ADR", "k3f9q8a1"],
      ["ADR-Event", "accepted"],
      ["ADR", "k3f9q8a1"],
      ["ADR-Event", "noted"],
    ];
    await writeFile(file, "feat: x\n\nRefs: 1\n");
    await r.git.appendTrailers(file, pairs, { ifExists: "add" });
    expect(await readFile(file, "utf8")).toBe(
      "feat: x\n\nRefs: 1\nADR: k3f9q8a1\nADR-Event: accepted\nADR: k3f9q8a1\nADR-Event: noted\n",
    );
    // The default still drops a repeat of the same key and value.
    await writeFile(file, "feat: x\n");
    await r.git.appendTrailers(file, pairs);
    expect(await readFile(file, "utf8")).toBe(
      "feat: x\n\nADR: k3f9q8a1\nADR-Event: accepted\nADR-Event: noted\n",
    );
  });

  it("symbolicRef reads a symbolic ref's target and is null otherwise", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    expect(await r.git.symbolicRef("HEAD")).toBe("refs/heads/main");
    await r.git.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await r.git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    expect(await r.git.symbolicRef("refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    expect(await r.git.symbolicRef("refs/heads/main")).toBeNull();
    expect(await r.git.symbolicRef("refs/remotes/upstream/HEAD")).toBeNull();
    await expect(r.git.symbolicRef("--all")).rejects.toBeInstanceOf(InvalidArgumentError);
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

describe("identity", () => {
  const withoutAuthor = (r: TempRepo) =>
    Git.open(r.root, {
      env: { ...r.git.options.env, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined },
    });

  it("comes from the GIT_AUTHOR_* variables", async () => {
    const r = await repo();
    expect(await r.git.identity()).toEqual({
      name: "Ledger Test",
      email: "ledger-test@example.com",
    });
  });

  it("comes from user.name and user.email", async () => {
    const r = await repo();
    await r.git.run(["config", "user.name", "Ada Lovelace"]);
    await r.git.run(["config", "user.email", "ada@example.com"]);
    expect(await (await withoutAuthor(r)).identity()).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
  });

  it("is null when nothing is configured, never guessed", async () => {
    const r = await repo();
    const git = await withoutAuthor(r);
    expect(await git.identity()).toBeNull();
    await r.git.run(["config", "user.name", "Ada Lovelace"]);
    expect(await git.identity()).toBeNull();
  });
});

describe("trailer blocks as git reads them", () => {
  const TRAILER_LINE = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/;
  /** The trailers the installed git reads in the last paragraph of `message`. */
  const gitTrailers = async (r: TempRepo, message: string): Promise<Trailer[]> => {
    const out = await r.git.run(["interpret-trailers", "--parse", "--no-divider"], {
      input: message.trimEnd(),
    });
    return Buffer.from(out.stdout)
      .toString()
      .split("\n")
      .flatMap((line) => {
        const m = TRAILER_LINE.exec(line.trimEnd());
        return m === null ? [] : [[m[1] ?? "", m[2] ?? ""] as const];
      });
  };
  /** Whether `commitMessage` merges `ADR: k` into the last paragraph of `message`. */
  const merged = async (r: TempRepo, message: string): Promise<boolean> => {
    const text = await r.git.commitMessage({
      message,
      trailers: [["ADR", "k"]],
      mergeTrailers: true,
    });
    if (text === `${message.trimEnd()}\nADR: k\n`) return true;
    expect(text).toBe(`${message.trimEnd()}\n\nADR: k\n`);
    return false;
  };
  const isCommentsOnly = (message: string) =>
    (
      message
        .trimEnd()
        .split(/\n[ \t\r]*\n/)
        .at(-1) ?? ""
    )
      .split("\n")
      .every((line) => line.startsWith("#") || /^[ \t\r]*$/.test(line));

  it.each([
    ["s\n\nRefs: #12", true],
    ["s\n\nRefs:#12", true],
    ["s\n\nRefs : #12", true],
    ["s\n\nRefs\t:#12", true],
    ["s\n\n2FA: on", true],
    ["s\n\n-x: y", true],
    ["s\n\nNote: we chose X", true],
    ["s\n\nSee the design doc at https://example.com/adr/42.", false],
    ["s\n\nWe decided: use X.", false],
    ["s\n\nWe decided: use Aurora.", false],
    ["s\n\n: x", false],
    ["s\n\nRefs foo: x", false],
    ["s\n\nCo-authored-by: A <a@x>\n  continued", true],
    ["s\n\nCo-authored-by: A <a@x>\n\tcontinued\nRefs: 1", true],
    ["s\n\nWhy.\n\nCo-authored-by: A <a@x>\nRefs: #12\n", true],
    ["s\n\n  indented: x\nRefs: 1", false],
    ["s\n\nprose\n  Refs: x", false],
    ["s\n\nSigned-off-by: A <a@x>\nwe paired\non this\ntoday", true],
    ["s\n\nSigned-off-by: A <a@x>\na\nb\nc\nd", false],
    ["s\n\nSigned-off-by: A <a@x>\n  wrapped\nprose", true],
    // git reads this as a block but finds no `Key: value` trailer in it, so ledger's trailers get
    // their own paragraph; git reads the same trailers either way.
    ["s\n\n(cherry picked from commit abc)\nprose", false],
    ["s\n\nRefs: 1\nprose", false],
    ["s\n\nRefs: #12\nsee the issue", false],
    ["s\n\nRefs: 1\n# a comment", true],
    ["s\n\n# a comment\nRefs: 1", true],
    // git reads `Refs: 1` as the block, but trailers appended after the comment would not join it.
    ["s\n\nRefs: 1\n\n# a comment", false],
    ["Refs: 1", false],
    ["docs: x", false],
    ["s\nmore title\n\nRefs: 1", true],
    ["s\n\nbody\n\nRefs: 1\n\n", true],
    ["s\n\nRefs: 1\n\nbody", false],
    // git's isspace (sane_ctype) is space, \t, \n and \r: \v and \f are content.
    ["s\n\nRefs: 1\n\v\nKey: v", false],
    ["s\n\nRefs: 1\n\f\nKey: v", false],
    ["s\n\nRefs: 1\n\r\nKey: v", true],
    ["s\n\nKey: v\n\vcont", false],
    ["s\n\nKey: v\n\fcont", false],
    ["s\n\nKey: v\n\rcont", true],
  ])("merges into %j: %s", async (message, expected) => {
    const r = await repo();
    expect(await merged(r, message)).toBe(expected);
    if (!isCommentsOnly(message)) {
      expect((await gitTrailers(r, message)).length > 0).toBe(expected);
    }
  });

  it("follows the installed git on lines that start with a URL (git 2.56, d122e37)", async () => {
    const r = await repo();
    for (const message of [
      "s\n\nhttps://example.com/x",
      "s\n\nRefs: #12\nhttps://example.com/x",
      "s\n\nhttps: //example.com/x",
    ]) {
      expect(await merged(r, message)).toBe((await gitTrailers(r, message)).length > 0);
    }
  });

  it("merges exactly when the installed git reads trailers in the last paragraph", async () => {
    const r = await repo();
    const ours: Trailer[] = [
      ["ADR", "k"],
      ["ADR-Event", "noted"],
    ];
    const line = fc.constantFrom(
      "Refs: #12",
      "Refs:#12",
      "Key : v",
      "Signed-off-by: A <a@x>",
      "(cherry picked from commit abc)",
      "  continued",
      "\tcontinued",
      "\v",
      "\f",
      "\vcontinued",
      "\fcontinued",
      "we paired on this",
      "See https://example.com/x",
      "We decided: use X.",
      "https://example.com/x",
      "# a comment",
      "",
    );
    await fc.assert(
      fc.asyncProperty(fc.array(line, { minLength: 1, maxLength: 7 }), async (last) => {
        const message = `chore: x\n\n${last.join("\n")}\n`;
        const own = await gitTrailers(r, message);
        await r.git.commit({ message, allowEmpty: true, mergeTrailers: true, trailers: ours });
        const [head] = await firstParentHistory(r.git, "HEAD");
        expect(head?.trailers).toEqual(isCommentsOnly(message) ? ours : [...own, ...ours]);
      }),
      { numRuns: 60 },
    );
  });

  it("reads the last paragraph with the user's trailer config", async () => {
    const r = await repo();
    const message = "chore: x\n\nRefs= 12\n";
    expect(await merged(r, message)).toBe(false);
    await r.git.run(["config", "trailer.separators", ":="]);
    expect(await merged(r, message)).toBe(true);
    await r.git.commit({
      message,
      allowEmpty: true,
      mergeTrailers: true,
      trailers: [["ADR", "k"]],
    });
    const [head] = await firstParentHistory(r.git, "HEAD");
    expect(head?.trailers).toEqual([
      ["Refs", "12"],
      ["ADR", "k"],
    ]);
  });

  it("never runs trailer commands while deciding", async () => {
    const r = await repo();
    const ran = join(await tempDir(), "ran");
    await r.git.run(["config", "trailer.refs.key", "Refs"]);
    await r.git.run(["config", "trailer.refs.cmd", `touch '${ran}'`]);
    expect(await merged(r, "chore: x\n\nRefs: 1")).toBe(true);
    await expect(stat(ran)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("asks git once, only for mergeTrailers with trailers", async () => {
    const r = await repo();
    const count = join(await tempDir(), "count");
    const binary = join(await tempDir(), "git-wrapper");
    await writeFile(
      binary,
      `#!/bin/sh\ncase " $* " in *" interpret-trailers "*) echo x >> '${count}';; esac\nexec git "$@"\n`,
    );
    await chmod(binary, 0o755);
    const git = await Git.open(r.root, { ...r.git.options, binary });
    const calls = async () =>
      (await readFile(count, "utf8").catch(() => "")).split("\n").filter((l) => l !== "").length;
    const trailers: Trailer[] = [["ADR", "k"]];
    const message = "chore: x\n\nRefs: 1\n";
    await git.commit({ message, allowEmpty: true, mergeTrailers: true, trailers });
    expect(await calls()).toBe(1);
    await git.commit({ message, allowEmpty: true, trailers });
    expect(await calls()).toBe(1);
    await git.commit({ message, allowEmpty: true, mergeTrailers: true });
    expect(await calls()).toBe(1);
    await git.commit({
      message: "chore: x\n\nRefs: 1\n\n# a comment\n",
      allowEmpty: true,
      mergeTrailers: true,
      trailers,
    });
    expect(await calls()).toBe(1);
  });

  it("commits trailers into the block git reads with mergeTrailers", async () => {
    const r = await repo();
    const ours: Trailer[] = [
      ["ADR", "k"],
      ["ADR-Event", "noted"],
    ];
    for (const [own, theirs] of [
      ["Co-authored-by: A <a@x>\n  continued", [["Co-authored-by", "A <a@x> continued"]]],
      ["Refs:#12", [["Refs", "#12"]]],
      ["Signed-off-by: A <a@x>\nwe paired on this", [["Signed-off-by", "A <a@x>"]]],
    ] as const) {
      const sha = await r.git.commit({
        message: `chore: x\n\n${own}\n`,
        allowEmpty: true,
        mergeTrailers: true,
        trailers: ours,
      });
      const [head] = await firstParentHistory(r.git, "HEAD");
      expect(head?.trailers).toEqual([...theirs, ...ours]);
      expect(
        Buffer.from((await r.git.run(["log", "-1", "--format=%B", sha])).stdout).toString(),
      ).toBe(`chore: x\n\n${own}\nADR: k\nADR-Event: noted\n\n`);
    }
  });
});

describe("commit with only and trailers", () => {
  const show = async (r: TempRepo, args: string[]) =>
    Buffer.from((await r.git.run(args)).stdout).toString();

  it("commits only the given paths, from the work tree, and keeps other staged changes", async () => {
    const r = await repo({ files: { "keep.txt": "k\n" } });
    await r.write("a.txt", "staged\n");
    await r.write("b.txt", "b\n");
    await r.stage("a.txt", "b.txt");
    await r.write("a.txt", "work tree\n");
    const sha = await r.git.commit({ message: "only a", only: ["a.txt"] });
    expect(await show(r, ["show", "--name-only", "--format=", sha])).toBe("a.txt\n");
    expect(await show(r, ["show", `${sha}:a.txt`])).toBe("work tree\n");
    expect(await r.git.stagedPaths(["."])).toEqual(["b.txt"]);
    await expect(r.git.commit({ message: "m", only: ["-x"] })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("writes trailers as the message's last paragraph", async () => {
    const r = await repo();
    const sha = await r.git.commit({
      message: "feat: x\n\nbody\n\n",
      allowEmpty: true,
      trailers: [
        ["ADR", "k3f9q8a1"],
        ["ADR-Event", "proposed"],
      ],
    });
    expect(await show(r, ["log", "-1", "--format=%B", sha])).toBe(
      "feat: x\n\nbody\n\nADR: k3f9q8a1\nADR-Event: proposed\n\n",
    );
    const plain = await r.git.commit({ message: "chore: y\n", allowEmpty: true });
    expect(await show(r, ["log", "-1", "--format=%B", plain])).toBe("chore: y\n\n");
  });

  it("appends trailers to the message's own trailer block with mergeTrailers", async () => {
    const r = await repo();
    await r.git.commit({
      message: "chore: x\n\nWhy.\n\nCo-authored-by: A <a@x>\nRefs: #12\n",
      allowEmpty: true,
      mergeTrailers: true,
      trailers: [
        ["ADR", "k"],
        ["ADR-Event", "noted"],
      ],
    });
    const [head] = await firstParentHistory(r.git, "HEAD");
    expect(head?.trailers).toEqual([
      ["Co-authored-by", "A <a@x>"],
      ["Refs", "#12"],
      ["ADR", "k"],
      ["ADR-Event", "noted"],
    ]);
  });

  it("keeps trailers exact under a hostile trailer config", async () => {
    const r = await repo();
    await r.git.run(["config", "trailer.ifexists", "addIfDifferent"]);
    await r.git.run(["config", "trailer.ADR.ifexists", "replace"]);
    await r.git.run(["config", "trailer.where", "start"]);
    const trailers: Trailer[] = [
      ["ADR", "k"],
      ["ADR-Event", "proposed"],
      ["ADR", "k"],
      ["ADR-Event", "accepted"],
      ["ADR", "a"],
      ["ADR-Event", "superseded"],
      ["ADR", "b"],
      ["ADR-Event", "superseded"],
    ];
    await r.git.commit({ message: "feat(adr): accept k", allowEmpty: true, trailers });
    const [head] = await firstParentHistory(r.git, "HEAD");
    expect(head?.trailers).toEqual(trailers);
    expect(head?.subject).toBe("feat(adr): accept k");
  });

  it("keeps a rendered template subject and its trailers exact under a hostile trailer config", async () => {
    const r = await repo();
    await r.git.run(["config", "trailer.ifexists", "replace"]);
    await r.git.run(["config", "trailer.where", "start"]);
    const t = parseCommitTemplate("docs(adr): {action} {title}", {
      vars: { action: 16 },
      where: "t",
    });
    const rendered = renderCommitMessage(t, {
      title: "Use event sourcing with one append-only log per subject for every record kind",
      vars: { action: "accept" },
      body: ["Supersedes ADR-0001: Old."],
    });
    const trailers: Trailer[] = [
      ["ADR", "k3f9q8a1"],
      ["ADR-Event", "accepted"],
      ["ADR", "a7c2m9xd"],
      ["ADR-Event", "superseded"],
    ];
    const sha = await r.git.commit({ message: rendered.message, allowEmpty: true, trailers });
    const [head] = await firstParentHistory(r.git, "HEAD");
    expect(head?.subject).toBe(rendered.subject);
    expect(head?.trailers).toEqual(trailers);
    expect(await show(r, ["log", "-1", "--format=%B", sha])).toBe(
      `${commitMessageText(rendered.message, trailers)}\n`,
    );
  });

  it("refuses trailers with an empty message", async () => {
    const r = await repo();
    for (const message of ["", " \n\n"]) {
      await expect(
        r.git.commit({ message, allowEmpty: true, trailers: [["ADR", "k"]] }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    expect(await r.git.resolveCommit("HEAD")).toBeNull();
  });
});

describe("committerIdentity", () => {
  it("reads GIT_COMMITTER_* or user.*, and is null without either", async () => {
    const r = await repo();
    expect(await r.git.committerIdentity()).toEqual({
      name: "Ledger Test",
      email: "ledger-test@example.com",
    });
    const bare = { ...r.env, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined };
    const none = await Git.open(r.root, { env: { ...bare, EMAIL: "guess@example.com" } });
    expect(await none.committerIdentity()).toBeNull();
    expect(await none.identity()).not.toBeNull();
    await r.git.run(["config", "user.name", "Config User"]);
    await r.git.run(["config", "user.email", "config@example.com"]);
    expect(await (await Git.open(r.root, { env: bare })).committerIdentity()).toEqual({
      name: "Config User",
      email: "config@example.com",
    });
    const env = { ...r.env, GIT_COMMITTER_NAME: "Bot", GIT_COMMITTER_EMAIL: "bot@example.com" };
    expect(await (await Git.open(r.root, { env })).committerIdentity()).toEqual({
      name: "Bot",
      email: "bot@example.com",
    });
  });
});

describe("staged, unstaged and untracked paths", () => {
  it("stagedPaths lists added and modified paths on an unborn and a born HEAD", async () => {
    const r = await repo();
    await r.writeFiles({ "log/a.txt": "a\n", "log/sub/b.txt": "b\n", "other.txt": "o\n" });
    await r.stage("log/a.txt", "log/sub/b.txt", "other.txt");
    expect(await r.git.stagedPaths(["log"])).toEqual(["log/a.txt", "log/sub/b.txt"]);
    expect(await r.git.stagedPaths(["log/sub", "other.txt"])).toEqual([
      "log/sub/b.txt",
      "other.txt",
    ]);
    expect(await r.git.stagedPaths(["log"], { addedOnly: true })).toEqual([
      "log/a.txt",
      "log/sub/b.txt",
    ]);
    await r.commit("initial");
    expect(await r.git.stagedPaths(["log"])).toEqual([]);

    await r.write("log/a.txt", "changed\n");
    await r.write("log/c.txt", "c\n");
    await r.stage("log/a.txt", "log/c.txt");
    await r.git.run(["rm", "-q", "--cached", "log/sub/b.txt"]);
    expect(await r.git.stagedPaths(["log"])).toEqual(["log/a.txt", "log/c.txt"]);
    expect(await r.git.stagedPaths(["log"], { addedOnly: true })).toEqual(["log/c.txt"]);
    expect(await r.git.stagedPaths([])).toEqual([]);
    await expect(r.git.stagedPaths(["-x"])).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("stagedPaths reads pathspecs literally", async () => {
    const r = await repo();
    await r.writeFiles({ "log/*.txt": "star\n", "log/a.txt": "a\n" });
    await r.stage("log/*.txt", "log/a.txt");
    expect(await r.git.stagedPaths(["log/*.txt"])).toEqual(["log/*.txt"]);
  });

  it("unstagedPaths lists work-tree changes to tracked files", async () => {
    const r = await repo({ files: { "log/a.txt": "a\n", "log/b.txt": "b\n", "c.txt": "c\n" } });
    await r.write("log/a.txt", "changed\n");
    await r.write("c.txt", "changed\n");
    await r.write("log/new.txt", "untracked\n");
    await r.write("log/b.txt", "staged\n");
    await r.stage("log/b.txt");
    expect(await r.git.unstagedPaths(["log"])).toEqual(["log/a.txt"]);
    expect(await r.git.unstagedPaths(["log", "c.txt"])).toEqual(["c.txt", "log/a.txt"]);
    expect(await r.git.unstagedPaths([])).toEqual([]);
  });

  it("untrackedPaths lists untracked and ignored files, not tracked ones", async () => {
    const r = await repo({ files: { ".gitignore": ".DS_Store\n", "log/a.txt": "a\n" } });
    await r.writeFiles({
      "log/.DS_Store": "x",
      "log/sub/notes.txt": "n\n",
      "outside.txt": "o\n",
    });
    expect(await r.git.untrackedPaths(["log"])).toEqual(["log/.DS_Store", "log/sub/notes.txt"]);
    expect(await r.git.untrackedPaths([])).toEqual([]);
    await expect(r.git.untrackedPaths(["-x"])).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe("tracked and changed paths", () => {
  it("trackedPaths lists the index, the work tree and a commit", async () => {
    const r = await repo({ files: { "a.txt": "a\n", "b/c.txt": "c\n", "gone.txt": "g\n" } });
    const first = await r.git.resolveCommit("HEAD");
    await r.write("new.txt", "n\n");
    await r.stage("new.txt");
    await r.remove("gone.txt");
    await r.write("untracked.txt", "u\n");
    expect(await r.git.trackedPaths("index")).toEqual(["a.txt", "b/c.txt", "gone.txt", "new.txt"]);
    expect(await r.git.trackedPaths("worktree")).toEqual(["a.txt", "b/c.txt", "new.txt"]);
    expect(await r.git.trackedPaths({ commit: first ?? "" })).toEqual([
      "a.txt",
      "b/c.txt",
      "gone.txt",
    ]);
    await expect(r.git.trackedPaths({ commit: "-x" })).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("changedPaths diffs a base against each head, listing both paths of a rename", async () => {
    const r = await repo({ files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" } });
    const base = (await r.git.resolveCommit("HEAD")) ?? "";
    await r.git.run(["mv", "a.txt", "moved.txt"]);
    await r.write("b.txt", "staged\n");
    await r.stage("b.txt");
    await r.write("c.txt", "unstaged\n");
    expect(await r.git.changedPaths(base, "index")).toEqual(["a.txt", "b.txt", "moved.txt"]);
    expect(await r.git.changedPaths(base, "worktree")).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
      "moved.txt",
    ]);
    const head = await r.commit("move", { all: true });
    expect(await r.git.changedPaths(base, { commit: head })).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
      "moved.txt",
    ]);
    expect(await r.git.changedPaths(head, { commit: head })).toEqual([]);
    // No base: every tracked path.
    expect(await r.git.changedPaths(null, "index")).toEqual(["b.txt", "c.txt", "moved.txt"]);
  });

  it("honours GIT_INDEX_FILE", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const alt = join(r.git.gitDir, "alt-index");
    const other = await Git.open(r.root, {
      ...r.git.options,
      env: { ...r.git.options.env, GIT_INDEX_FILE: alt },
    });
    await other.run(["read-tree", "HEAD"]);
    await r.write("b.txt", "b\n");
    await other.add(["b.txt"]);
    const head = (await r.git.resolveCommit("HEAD")) ?? "";
    expect(await other.trackedPaths("index")).toEqual(["a.txt", "b.txt"]);
    expect(await other.changedPaths(head, "index")).toEqual(["b.txt"]);
    expect(await r.git.trackedPaths("index")).toEqual(["a.txt"]);
    expect(await r.git.changedPaths(head, "index")).toEqual([]);
  });
});
