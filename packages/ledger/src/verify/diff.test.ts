import { describe, expect, it } from "vitest";
import { MemoryTree, type TreeEntry, type TreeReader } from "../git/tree.js";
import { diffTrees } from "./diff.js";

function entries(list: readonly TreeEntry[]): TreeReader {
  return {
    label: "fake",
    commit: null,
    list: async (prefix) => list.filter((e) => e.path.startsWith(`${prefix}/`)),
    read: async () => null,
    readMany: async () => new Map(),
  };
}

describe("diffTrees", () => {
  it("reports everything as added without a base", async () => {
    const head = new MemoryTree({ "log/b": "b", "log/a": "a", "other/c": "c" });
    expect(await diffTrees(null, head, "log")).toEqual([
      { path: "log/a", status: "added" },
      { path: "log/b", status: "added" },
    ]);
  });

  it("reports added, deleted and modified paths by oid, sorted", async () => {
    const base = new MemoryTree({ "log/same": "s", "log/gone": "g", "log/edit": "1" });
    const head = new MemoryTree({ "log/same": "s", "log/new": "n", "log/edit": "2" });
    expect(await diffTrees(base, head, "log")).toEqual([
      { path: "log/edit", status: "modified" },
      { path: "log/gone", status: "deleted" },
      { path: "log/new", status: "added" },
    ]);
  });

  it("reports a rename as a delete plus an add", async () => {
    const base = new MemoryTree({ "log/a": "x" });
    const head = new MemoryTree({ "log/b": "x" });
    expect(await diffTrees(base, head, "log")).toEqual([
      { path: "log/a", status: "deleted" },
      { path: "log/b", status: "added" },
    ]);
  });

  it("treats entries without an oid as unchanged only for the same type", async () => {
    const link: TreeEntry = { path: "log/l", oid: null, type: "symlink" };
    const other: TreeEntry = { path: "log/l", oid: null, type: "other" };
    const file: TreeEntry = { path: "log/l", oid: "a".repeat(40), type: "file" };
    expect(await diffTrees(entries([link]), entries([link]), "log")).toEqual([]);
    expect(await diffTrees(entries([link]), entries([other]), "log")).toEqual([
      { path: "log/l", status: "modified" },
    ]);
    expect(await diffTrees(entries([link]), entries([file]), "log")).toEqual([
      { path: "log/l", status: "modified" },
    ]);
  });
});
