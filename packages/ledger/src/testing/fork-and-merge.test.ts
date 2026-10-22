import { afterEach, describe, expect, it } from "vitest";
import { GitError, InvalidArgumentError } from "../errors.js";
import { forkAndMerge } from "./fork-and-merge.js";
import { createTempRepo, type TempRepo } from "./temp-repo.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  cleanup.push(() => r.dispose());
  return r;
}

async function out(r: TempRepo, args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout)
    .toString()
    .trim();
}

const parents = async (r: TempRepo, sha: string): Promise<string[]> =>
  (await out(r, ["rev-list", "--parents", "-n", "1", sha])).split(" ").slice(1);

const files = async (r: TempRepo, sha: string): Promise<string[]> =>
  (await out(r, ["ls-tree", "-r", "--name-only", sha])).split("\n");

const branches = (r: TempRepo): Promise<string> =>
  out(r, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);

describe("forkAndMerge", () => {
  it("merges both sides with a merge commit whose parents are left and right", async () => {
    const r = await repo({ files: { "base.txt": "base\n" } });
    const res = await forkAndMerge(r, {
      left: (t) => t.write("left.txt", "l\n"),
      right: (t) => t.write("right.txt", "r\n"),
    });
    expect(await parents(r, res.left)).toEqual([res.base]);
    expect(await parents(r, res.right)).toEqual([res.base]);
    expect(await parents(r, res.merged)).toEqual([res.left, res.right]);
    expect(await files(r, res.merged)).toEqual(["base.txt", "left.txt", "right.txt"]);
    expect(await out(r, ["rev-parse", "HEAD"])).toBe(res.merged);
    expect(await out(r, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(await branches(r)).toBe("main");
    expect(await out(r, ["status", "--porcelain"])).toBe("");
  });

  it("rebases right onto left and fast-forwards, keeping history linear", async () => {
    const r = await repo({ files: { "base.txt": "base\n" } });
    const res = await forkAndMerge(r, {
      left: (t) => t.write("left.txt", "l\n"),
      right: async (t) => {
        await t.write("r1.txt", "1\n");
        await t.stage("r1.txt");
        await t.commit("r1");
        await t.write("r2.txt", "2\n");
      },
      strategy: "rebase",
    });
    expect(await parents(r, res.left)).toEqual([res.base]);
    expect(await out(r, ["rev-list", "--count", `${res.base}..${res.right}`])).toBe("2");
    const linear = (await out(r, ["rev-list", "--parents", `${res.base}..${res.merged}`])).split(
      "\n",
    );
    expect(linear).toHaveLength(3);
    for (const line of linear) expect(line.split(" ")).toHaveLength(2);
    const rebased = await out(r, ["rev-list", "--reverse", `${res.left}..${res.merged}`]);
    expect((await parents(r, rebased.split("\n")[0] ?? ""))[0]).toBe(res.left);
    expect(await out(r, ["log", "--format=%s", `${res.left}..${res.merged}`])).toBe("right\nr1");
    const ancestor = await r.git.run(["merge-base", "--is-ancestor", res.right, res.merged], {
      okCodes: [0, 1],
    });
    expect(ancestor.code).toBe(1);
    expect(await files(r, res.merged)).toEqual(["base.txt", "left.txt", "r1.txt", "r2.txt"]);
    expect(await branches(r)).toBe("main");
  });

  it("commits deletions and uses the temp repo clock on both strategies", async () => {
    const at = new Date("2024-01-02T03:04:05Z");
    for (const strategy of ["merge", "rebase"] as const) {
      const r = await repo({ files: { "a.txt": "a\n", "b.txt": "b\n" }, clock: () => at });
      const res = await forkAndMerge(r, {
        left: (t) => t.remove("a.txt"),
        right: (t) => t.write("c.txt", "c\n"),
        strategy,
      });
      expect(await files(r, res.merged)).toEqual(["b.txt", "c.txt"]);
      const dates = await out(r, ["log", "--format=%aI %cI", `${res.base}..${res.merged}`]);
      for (const line of dates.split("\n")) {
        expect(line).toBe("2024-01-02T03:04:05Z 2024-01-02T03:04:05Z");
      }
    }
  });

  it("returns base for a side that changes nothing", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const res = await forkAndMerge(r, {
      left: async () => {},
      right: (t) => t.write("b.txt", "b\n"),
    });
    expect(res.left).toBe(res.base);
    expect(await parents(r, res.merged)).toEqual([res.base, res.right]);
  });

  it("aborts a conflicting merge or rebase and rethrows the GitError", async () => {
    for (const strategy of ["merge", "rebase"] as const) {
      const r = await repo({ files: { "a.txt": "a\n" } });
      const run = forkAndMerge(r, {
        left: (t) => t.write("a.txt", "left\n"),
        right: (t) => t.write("a.txt", "right\n"),
        strategy,
      });
      await expect(run).rejects.toBeInstanceOf(GitError);
      expect(await out(r, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
      expect(await out(r, ["status", "--porcelain"])).toBe("");
      expect(await branches(r)).toBe("main");
    }
  });

  it("needs a commit and a branch at HEAD", async () => {
    const empty = await repo();
    const noop = { left: async () => {}, right: async () => {} };
    await expect(forkAndMerge(empty, noop)).rejects.toBeInstanceOf(InvalidArgumentError);
    const detached = await repo({ files: { "a.txt": "a\n" } });
    await detached.git.run(["checkout", "-q", "--detach"]);
    await expect(forkAndMerge(detached, noop)).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
