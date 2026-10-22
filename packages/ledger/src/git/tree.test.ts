import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidArgumentError, RefNotFoundError } from "../errors.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { Git } from "./git.js";
import { indexReader, MemoryTree, refReader, type TreeReader, worktreeReader } from "./tree.js";

const repos: TempRepo[] = [];

afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

const text = (bytes: Uint8Array | null | undefined) =>
  bytes === null || bytes === undefined ? null : new TextDecoder().decode(bytes);

async function hashObject(git: Git, content: string): Promise<string> {
  const r = await git.run(["hash-object", "--stdin"], { input: content });
  return Buffer.from(r.stdout).toString().trim();
}

describe("readers", () => {
  it("reads a past commit, the index and the work tree independently", async () => {
    const r = await repo({ files: { "log/a.txt": "v1\n" } });
    const v1 = await r.git.resolveCommit("HEAD");
    await r.write("log/a.txt", "v2\n");
    await r.stage("log/a.txt");
    await r.commit("v2");
    await r.write("log/a.txt", "v3\n");
    await r.stage("log/a.txt");
    await r.write("log/a.txt", "v2\n"); // staged-only change: only the index sees v3

    const past = await refReader(r.git, v1 ?? "");
    const head = await refReader(r.git, "HEAD");
    const index = await indexReader(r.git);
    const worktree = worktreeReader(r.git);
    expect(text(await past.read("log/a.txt"))).toBe("v1\n");
    expect(text(await head.read("log/a.txt"))).toBe("v2\n");
    expect(text(await index.read("log/a.txt"))).toBe("v3\n");
    expect(text(await worktree.read("log/a.txt"))).toBe("v2\n");
    expect(past.commit).toBe(v1);
    expect(past.label).toBe(`${v1} (${v1?.slice(0, 7)})`);
    expect(index.label).toBe("index");
    expect(worktree.label).toBe("worktree");
  });

  it("returns null for missing paths and directories", async () => {
    const r = await repo({ files: { "log/a.txt": "a\n" } });
    const readers: TreeReader[] = [
      await refReader(r.git, "main"),
      await indexReader(r.git),
      worktreeReader(r.git),
    ];
    for (const reader of readers) {
      expect(await reader.read("log/missing.txt")).toBeNull();
      expect(await reader.read("log")).toBeNull();
      expect([...(await reader.readMany(["log/a.txt", "nope"])).keys()]).toEqual(["log/a.txt"]);
    }
  });

  it("lists entries under a prefix, sorted, with equal oids across readers", async () => {
    const r = await repo({
      files: { "log/b.txt": "b\n", "log/a/x.txt": "x\n", "log-other.txt": "o\n", "top.txt": "t\n" },
    });
    const expected = [
      { path: "log/a/x.txt", oid: await hashObject(r.git, "x\n"), type: "file" },
      { path: "log/b.txt", oid: await hashObject(r.git, "b\n"), type: "file" },
    ];
    for (const reader of [
      await refReader(r.git, "main"),
      await indexReader(r.git),
      worktreeReader(r.git),
    ]) {
      expect(await reader.list("log")).toEqual(expected);
      expect(await reader.list("log/")).toEqual(expected);
      expect((await reader.list("")).map((e) => e.path)).toEqual([
        "log-other.txt",
        "log/a/x.txt",
        "log/b.txt",
        "top.txt",
      ]);
      expect(await reader.list("missing")).toEqual([]);
    }
    expect(
      await new MemoryTree({ "log/b.txt": "b\n", "log/a/x.txt": "x\n", logx: "" }).list("log"),
    ).toEqual(expected);
  });

  it("classifies symlinks and odd names", async () => {
    const r = await repo({ files: { "log/a.txt": "a\n" } });
    await symlink("a.txt", join(r.root, "log", "link"));
    await r.write("log/new\nline.txt", "n\n");
    const worktree = await worktreeReader(r.git).list("log");
    expect(worktree).toEqual([
      { path: "log/a.txt", oid: await hashObject(r.git, "a\n"), type: "file" },
      { path: "log/link", oid: null, type: "symlink" },
      { path: "log/new\nline.txt", oid: null, type: "other" },
    ]);
    await r.stage("log/link");
    await r.commit("link");
    const head = await (await refReader(r.git, "HEAD")).list("log");
    expect(head.find((e) => e.path === "log/link")).toEqual({
      path: "log/link",
      oid: null,
      type: "symlink",
    });
  });

  it("reports an unmerged index path once, as other", async () => {
    const r = await repo({ files: { "a.txt": "base\n" } });
    await r.checkout("topic", { create: true });
    await r.write("a.txt", "topic\n");
    await r.commit("topic", { all: true });
    await r.checkout("main");
    await r.write("a.txt", "main\n");
    await r.commit("main", { all: true });
    await expect(r.merge("topic")).rejects.toThrow();
    const index = await indexReader(r.git);
    expect(await index.list("")).toEqual([{ path: "a.txt", oid: null, type: "other" }]);
    expect(await index.read("a.txt")).toBeNull();
  });

  it("refReader rejects unknown and option-like refs", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    await expect(refReader(r.git, "nope")).rejects.toBeInstanceOf(RefNotFoundError);
    await expect(refReader(r.git, "nope")).rejects.toMatchObject({ ref: "nope" });
    await expect(refReader(r.git, "-x")).rejects.toBeInstanceOf(InvalidArgumentError);
    const unborn = await repo();
    await expect(refReader(unborn.git, "HEAD")).rejects.toBeInstanceOf(RefNotFoundError);
    await expect((await indexReader(unborn.git)).list("")).resolves.toEqual([]);
  });

  it("reads a bare repository populated by a push", async () => {
    const src = await repo({ files: { "log/a.txt": "a\n" } });
    const bare = await repo({ bare: true });
    await src.git.run(["push", "-q", bare.root, "main"]);
    const reader = await refReader(bare.git, "main");
    expect(text(await reader.read("log/a.txt"))).toBe("a\n");
    expect((await reader.list("")).map((e) => e.path)).toEqual(["log/a.txt"]);
  });

  it("gives a CRLF checkout of an LF blob the blob's oid", async () => {
    const r = await repo();
    await r.git.run(["config", "core.autocrlf", "true"]);
    await r.write("log/a.txt", "one\ntwo\n");
    await r.stage("log/a.txt");
    await r.commit("lf");
    await r.remove("log/a.txt");
    await r.git.run(["checkout", "--", "log/a.txt"]);
    const worktree = worktreeReader(r.git);
    expect(text(await worktree.read("log/a.txt"))).toBe("one\r\ntwo\r\n");
    expect(await worktree.list("log")).toEqual(await (await refReader(r.git, "HEAD")).list("log"));
  });

  it("works in a SHA-256 repository", async () => {
    const r = await repo({ objectFormat: "sha256", files: { "log/a.txt": "a\n" } });
    const reader = await refReader(r.git, "HEAD");
    expect(reader.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(text(await reader.read("log/a.txt"))).toBe("a\n");
    const [entry] = await reader.list("log");
    expect(entry?.oid).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await new MemoryTree({ "log/a.txt": "a\n" }, { objectFormat: "sha256" }).list("log"),
    ).toEqual(await reader.list("log"));
    expect(await worktreeReader(r.git).list("log")).toEqual(await reader.list("log"));
  });
});

describe("MemoryTree", () => {
  it("computes the same oids as git hash-object", async () => {
    const r = await repo();
    const bytes = new Uint8Array([0, 1, 2, 255, 10]);
    const tree = new MemoryTree({ "a.txt": "hello\n", "b.bin": bytes, c: "" });
    const binOid = await r.git.run(["hash-object", "--stdin"], { input: bytes });
    expect((await tree.list("")).map((e) => e.oid)).toEqual([
      await hashObject(r.git, "hello\n"),
      Buffer.from(binOid.stdout).toString().trim(),
      await hashObject(r.git, ""),
    ]);
    expect(tree.label).toBe("memory");
    expect(tree.commit).toBeNull();
    expect(text(await tree.read("a.txt"))).toBe("hello\n");
    expect(await tree.read("nope")).toBeNull();
  });
});
