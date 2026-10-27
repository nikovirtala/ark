import { afterEach, describe, expect, it } from "vitest";
import { MemoryTree, worktreeReader } from "../git/tree.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  firstLine,
  headBytes,
  headTree,
  holdsText,
  withoutPaths,
  writeIndexCopy,
} from "./copies.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files?: Record<string, string>): Promise<TempRepo> {
  const r = await createTempRepo(files === undefined ? {} : { files });
  repos.push(r);
  return r;
}
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

describe("index copies", () => {
  it("holdsText compares bytes exactly", () => {
    expect(holdsText(bytes("a\n"), "a\n")).toBe(true);
    expect(holdsText(bytes("a"), "a\n")).toBe(false);
    expect(holdsText(bytes("b\n"), "a\n")).toBe(false);
    expect(holdsText(null, "")).toBe(false);
    expect(holdsText(bytes(""), "")).toBe(true);
  });

  it("headBytes and headTree read HEAD, or nothing on an unborn HEAD", async () => {
    const unborn = await repo();
    expect(await headBytes(unborn.git, "a.md")).toBeNull();
    expect(await (await headTree(unborn.git, null)).list("")).toEqual([]);
    const r = await repo({ "a.md": "A\n" });
    await r.write("a.md", "changed\n");
    expect(text(await headBytes(r.git, "a.md"))).toBe("A\n");
    expect(await headBytes(r.git, "b.md")).toBeNull();
    const head = await r.git.resolveCommit("HEAD");
    expect(text(await (await headTree(r.git, head)).read("a.md"))).toBe("A\n");
  });

  it("writeIndexCopy writes a differing work-tree copy and says whether to stage", async () => {
    const r = await repo({ "log/index.md": "old\n" });
    const first = await writeIndexCopy(r.git, "log/index.md", "new\n");
    expect(first).toEqual({ wrote: true, old: bytes("old\n"), stage: true });
    expect(text(await worktreeReader(r.git).read("log/index.md"))).toBe("new\n");
    await r.stage("log/index.md");
    expect(await writeIndexCopy(r.git, "log/index.md", "new\n")).toEqual({
      wrote: false,
      old: bytes("new\n"),
      stage: false,
    });
    const created = await writeIndexCopy(r.git, "other/index.md", "x\n");
    expect(created).toEqual({ wrote: true, old: null, stage: true });
  });

  it("withoutPaths hides deleted paths from every read", async () => {
    const tree = new MemoryTree({ "d/.gitkeep": "", "d/a": "a" });
    expect(withoutPaths(tree, new Set())).toBe(tree);
    const t = withoutPaths(tree, new Set(["d/.gitkeep"]));
    expect(t.commit).toBeNull();
    expect((await t.list("d")).map((e) => e.path)).toEqual(["d/a"]);
    expect(await t.read("d/.gitkeep")).toBeNull();
    expect(text(await t.read("d/a"))).toBe("a");
    const many = await t.readMany(["d/.gitkeep", "d/a"]);
    expect([...many.keys()]).toEqual(["d/a"]);
  });

  it("firstLine keeps the first line of an error message", () => {
    expect(firstLine(new Error("one\ntwo"))).toBe("one");
    expect(firstLine("plain")).toBe("plain");
  });
});
