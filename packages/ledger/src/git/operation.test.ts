import { afterEach, describe, expect, it } from "vitest";
import { createSpawnLog, type SpawnLog } from "../testing/spawn-log.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { Git } from "./git.js";
import {
  currentGitOperation,
  GitOperation,
  invalidateGitOperation,
  isReadOnlyGitCommand,
  type Resident,
  withGitOperation,
  withNewGitOperation,
} from "./operation.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A temp repo with one commit, opened through a counting git wrapper. */
async function counted(): Promise<{ r: TempRepo; git: Git; log: SpawnLog }> {
  const r = await createTempRepo({ files: { "a.txt": "a\n" } });
  cleanup.push(() => r.dispose());
  const log = await createSpawnLog();
  cleanup.push(() => log.dispose());
  const git = await Git.open(r.root, { binary: log.binary, env: r.env });
  return { r, git, log };
}

/** A stand-in long-lived process that exits when its input ends. */
function fakeResident(): Resident & { ended: number } {
  let exit = () => {};
  const exited = new Promise<void>((res) => {
    exit = res;
  });
  const r = {
    ended: 0,
    exited,
    end() {
      r.ended++;
      setTimeout(exit, 1);
    },
  };
  return r;
}

describe("isReadOnlyGitCommand", () => {
  it.each([
    [["rev-parse", "--verify", "HEAD"], true],
    [["cat-file", "--batch"], true],
    [["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"], true],
    [["--literal-pathspecs", "diff", "--cached", "--name-only"], true],
    [["--literal-pathspecs", "ls-files", "--others", "-z"], true],
    [["--no-pager", "--no-optional-locks", "--git-dir=/x", "log", "-1"], true],
    [["--work-tree=/x", "show", "HEAD"], true],
    [["ls-tree", "-r", "HEAD"], true],
    [["rev-list", "HEAD"], true],
    [["merge-base", "a", "b"], true],
    [["grep", "x"], true],
    [["version"], true],
    [["for-each-ref"], true],
    [["show-ref"], true],
    [["remote"], true],
    [["remote", "-v"], true],
    [["remote", "--verbose"], true],
    [["remote", "add", "origin", "/x"], false],
    [["interpret-trailers", "--parse", "--no-divider"], true],
    [["interpret-trailers", "--in-place", "--trailer", "a: b", "--", "/m"], false],
    [["hash-object", "--stdin-paths"], true],
    [["hash-object", "-w", "--stdin"], false],
    [["symbolic-ref", "-q", "--end-of-options", "refs/remotes/origin/HEAD"], true],
    [["symbolic-ref", "--short", "--no-recurse", "--quiet", "HEAD"], true],
    [["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], false],
    [["symbolic-ref", "-d", "refs/remotes/origin/HEAD"], false],
    [["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], false],
    [["symbolic-ref"], false],
    [["config", "--get", "core.hooksPath"], false],
    [["add", "--", "a"], false],
    [["--literal-pathspecs", "commit", "--file=-"], false],
    [["update-ref", "refs/x", "HEAD"], false],
    [["status"], false],
    [["-c", "rev-parse"], false],
    [["frobnicate"], false],
    [[], false],
  ] as const)("%j is read-only: %s", (args, expected) => {
    expect(isReadOnlyGitCommand(args)).toBe(expected);
  });
});

describe("withGitOperation", () => {
  it("returns fn's value and rethrows its error", async () => {
    expect(await withGitOperation(async () => 42)).toBe(42);
    const boom = new Error("boom");
    await expect(
      withGitOperation(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(currentGitOperation()).toBeNull();
  });

  it("joins an active operation; withNewGitOperation doesn't", async () => {
    await withGitOperation(async () => {
      const outer = currentGitOperation();
      expect(outer).not.toBeNull();
      expect(await withGitOperation(async () => currentGitOperation())).toBe(outer);
      const inner = await withNewGitOperation(async () => currentGitOperation());
      expect(inner).not.toBe(outer);
      expect(inner?.closed).toBe(true);
      expect(currentGitOperation()).toBe(outer);
    });
  });

  it("gives concurrent operations their own", async () => {
    let release = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const seen = Promise.all(
      [0, 1].map(() =>
        withGitOperation(async () => {
          const op = currentGitOperation();
          await gate;
          return op;
        }),
      ),
    );
    release();
    const [a, b] = await seen;
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("is over once fn settles: a late call sees no operation", async () => {
    let late: Promise<GitOperation | null> = Promise.resolve(null);
    let inside: GitOperation | null = null;
    await withGitOperation(async () => {
      inside = currentGitOperation();
      late = new Promise((res) => setTimeout(() => res(currentGitOperation()), 5));
    });
    expect(inside).not.toBeNull();
    expect(await late).toBeNull();
  });

  it("ends the generation on invalidateGitOperation, and does nothing outside one", async () => {
    invalidateGitOperation();
    await withGitOperation(async () => {
      const op = currentGitOperation() as GitOperation;
      const before = op.generation;
      invalidateGitOperation();
      expect(op.generation).toBe(before + 1);
    });
  });
});

describe("GitOperation", () => {
  it("keeps one memo per generation and evicts rejections", async () => {
    const op = new GitOperation();
    let calls = 0;
    const compute = async () => ++calls;
    expect(await op.memo("k", compute)).toBe(1);
    expect(await op.memo("k", compute)).toBe(1);
    op.endGeneration();
    expect(await op.memo("k", compute)).toBe(2);
    await expect(op.memo("e", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await op.memo("e", async () => "ok")).toBe("ok");
    await op.close();
  });

  it("retires residents on a generation end and waits for them on close", async () => {
    const op = new GitOperation();
    const a = fakeResident();
    expect(op.resident("k", () => a)).toBe(a);
    expect(op.resident("k", fakeResident)).toBe(a);
    expect(op.residentCount).toBe(1);
    op.endGeneration();
    expect(a.ended).toBe(1);
    expect(op.residentCount).toBe(0);
    const b = fakeResident();
    expect(op.resident("k", () => b)).toBe(b);
    await op.close();
    expect(b.ended).toBe(1);
    expect(op.closed).toBe(true);
  });

  it("marks a key failed only for its current resident", async () => {
    const op = new GitOperation();
    const old = fakeResident();
    op.resident("k", () => old);
    op.endGeneration();
    const current = fakeResident();
    op.resident("k", () => current);
    op.residentFailed("k", old);
    expect(op.resident("k", fakeResident)).toBe(current);
    op.residentFailed("k", current);
    expect(current.ended).toBe(1);
    expect(op.resident("k", fakeResident)).toBeNull();
    op.endGeneration();
    expect(op.resident("k", fakeResident)).not.toBeNull();
    await op.close();
  });
});

describe("memoized git answers", () => {
  const SHALLOW = "rev-parse --is-shallow-repository";
  const SYMREF = "symbolic-ref -q --end-of-options refs/remotes/origin/HEAD";

  it("asks once per generation in an operation, and every time outside one", async () => {
    const { git, log } = await counted();
    await git.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    expect(await git.isShallow()).toBe(false);
    expect(await git.isShallow()).toBe(false);
    expect(await log.count(SHALLOW)).toBe(2);
    await withGitOperation(async () => {
      const other = await Git.open(git.root as string, git.options);
      expect(await git.isShallow()).toBe(false);
      expect(await other.isShallow()).toBe(false);
      expect(await git.symbolicRef("refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
      expect(await other.symbolicRef("refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    });
    expect(await log.count(SHALLOW)).toBe(3);
    expect(await log.count(SYMREF)).toBe(1);
  });

  it("drops them after a mutating command through another Git, or an invalidation", async () => {
    const { r, git, log } = await counted();
    await git.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git.run(["update-ref", "refs/remotes/origin/x", "HEAD"]);
    await git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await withGitOperation(async () => {
      expect(await git.symbolicRef("refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
      await r.git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/x"]);
      expect(await git.symbolicRef("refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/x");
      expect(await git.isShallow()).toBe(false);
      invalidateGitOperation();
      expect(await git.isShallow()).toBe(false);
    });
    expect(await log.count(SYMREF)).toBe(2);
    expect(await log.count("rev-parse --is-shallow-repository")).toBe(2);
  });

  it("keeps instances with different environments apart", async () => {
    const { git, log } = await counted();
    const other = await Git.open(git.root as string, {
      ...git.options,
      env: { ...git.options.env, ARK_TEST_MARKER: "1" },
    });
    await withGitOperation(async () => {
      await git.isShallow();
      await other.isShallow();
    });
    expect(await log.count("rev-parse --is-shallow-repository")).toBe(2);
  });
});
