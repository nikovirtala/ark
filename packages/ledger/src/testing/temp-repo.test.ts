import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { firstParentHistory } from "../git/history.js";
import { refReader } from "../git/tree.js";
import { createTempRepo, type TempRepo } from "./temp-repo.js";

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

describe("createTempRepo", () => {
  it("doesn't see the developer's global or system config", async () => {
    const outer = await mkdtemp(join(tmpdir(), "ledger-outer-"));
    cleanup.push(() => rm(outer, { recursive: true, force: true }));
    const outerConfig = join(outer, ".gitconfig");
    await writeFile(outerConfig, "[ledger]\n\tmarker = outer\n[user]\n\tname = Outer\n");
    vi.stubEnv("HOME", outer);
    vi.stubEnv("GIT_CONFIG_GLOBAL", outerConfig);
    vi.stubEnv("XDG_CONFIG_HOME", outer);
    const r = await repo();
    const marker = await r.git.run(["config", "--get", "ledger.marker"], { okCodes: [0, 1] });
    expect(marker.code).toBe(1);
    const name = await r.git.run(["config", "--get", "user.name"], { okCodes: [0, 1] });
    expect(name.code).toBe(1);
    const sign = await r.git.run(["config", "--get", "commit.gpgsign"]);
    expect(Buffer.from(sign.stdout).toString()).toBe("false\n");
  });

  it("isolates git init and the repo from an outer GIT_DIR and GIT_INDEX_FILE", async () => {
    const outer = await mkdtemp(join(tmpdir(), "ledger-outer-"));
    cleanup.push(() => rm(outer, { recursive: true, force: true }));
    vi.stubEnv("GIT_DIR", join(outer, "bogus.git"));
    vi.stubEnv("GIT_INDEX_FILE", join(outer, "index"));
    const r = await repo({ files: { "a.txt": "a\n" } });
    expect(r.git.gitDir).toBe(join(r.root, ".git"));
    await expect(stat(join(outer, "bogus.git"))).rejects.toThrow();
    await expect(stat(join(outer, "index"))).rejects.toThrow();
  });

  it("exposes an env that keeps a spawned process out of an outer GIT_DIR", async () => {
    const outer = await mkdtemp(join(tmpdir(), "ledger-outer-"));
    cleanup.push(() => rm(outer, { recursive: true, force: true }));
    vi.stubEnv("GIT_DIR", join(outer, "bogus.git"));
    vi.stubEnv("GIT_WORK_TREE", outer);
    const r = await repo({ files: { "a.txt": "a\n" } });
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      expect(Object.hasOwn(r.env, k)).toBe(true);
      expect(r.env[k]).toBeUndefined();
    }
    expect(r.env.GIT_AUTHOR_EMAIL).toBe("ledger-test@example.com");
    expect(Object.isFrozen(r.env)).toBe(true);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...r.env })) {
      if (v !== undefined) env[k] = v;
    }
    const { stdout } = await promisify(execFile)(
      "git",
      ["rev-parse", "--absolute-git-dir", "--show-toplevel"],
      { cwd: r.root, env },
    );
    expect(stdout).toBe(`${join(r.root, ".git")}\n${r.root}\n`);
  });

  it("commits files, branches and merges on the initial branch", async () => {
    const r = await repo({ initialBranch: "trunk", files: { "a.txt": "a\n" } });
    expect(await r.git.resolveCommit("trunk")).not.toBeNull();
    await r.checkout("topic", { create: true });
    await r.write("dir/b.txt", "b\n");
    await r.stage("dir/b.txt");
    await r.commit("add b", { trailers: [["Issue", "m4p8x2kd"]] });
    await r.checkout("trunk");
    const merged = await r.merge("topic", { noFf: true, message: "merge topic" });
    const [head] = await firstParentHistory(r.git, "HEAD");
    expect(head).toMatchObject({ sha: merged, subject: "merge topic" });
    await r.remove("dir");
    const removed = await r.commit("remove dir", { all: true });
    const tree = await refReader(r.git, removed);
    expect((await tree.list("")).map((e) => e.path)).toEqual(["a.txt"]);
  });

  it("writes a map of files", async () => {
    const r = await repo();
    await r.writeFiles({ "log/a.txt": "a\n", "log/b/c.bin": new Uint8Array([0, 1]) });
    await r.stage("log");
    await r.commit("files");
    const tree = await refReader(r.git, "HEAD");
    expect((await tree.list("log")).map((e) => e.path)).toEqual(["log/a.txt", "log/b/c.bin"]);
    expect(await tree.read("log/b/c.bin")).toEqual(new Uint8Array([0, 1]));
  });

  it("uses fixed dates when a clock is given", async () => {
    const r = await repo({ clock: () => new Date("2026-10-22T10:15:00Z") });
    await r.commit("empty", { allowEmpty: true });
    const [c] = await firstParentHistory(r.git, "HEAD");
    expect(c?.authorDate).toBe("2026-10-22T10:15:00Z");
    expect(c?.committerDate).toBe("2026-10-22T10:15:00Z");
  });

  it("supports SHA-256", async () => {
    const r = await repo({ objectFormat: "sha256" });
    expect(await r.git.objectFormat()).toBe("sha256");
  });

  it("creates a bare repo whose work-tree helpers throw", async () => {
    const bare = await repo({ bare: true, initialBranch: "trunk" });
    expect(bare.git.root).toBeNull();
    expect(bare.root).toBe(bare.git.gitDir);
    const head = await bare.git.run(["symbolic-ref", "HEAD"]);
    expect(Buffer.from(head.stdout).toString()).toBe("refs/heads/trunk\n");
    await expect(bare.write("a", "a")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(bare.remove("a")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(bare.writeFiles({})).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(bare.stage("a")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(bare.commit("m")).rejects.toThrow("operation needs a work tree");
    await expect(bare.checkout("x")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(bare.merge("x")).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(createTempRepo({ bare: true, files: { a: "a" } })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it("removes its directory on dispose and async dispose", async () => {
    const a = await createTempRepo();
    await a.dispose();
    await expect(stat(a.root)).rejects.toThrow();
    const b = await createTempRepo();
    await b[Symbol.asyncDispose]();
    await expect(stat(b.root)).rejects.toThrow();
  });
});
