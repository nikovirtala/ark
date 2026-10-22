import type { TreeEntry, TreeReader } from "../git/tree.js";

export interface Change {
  readonly path: string;
  readonly status: "added" | "deleted" | "modified";
}

function same(a: TreeEntry, b: TreeEntry): boolean {
  return a.type === b.type && a.oid === b.oid;
}

/**
 * The changes from `base` to `head` under `prefix`, sorted by path, by comparing oids (every
 * reader supplies them). No rename detection: a rename is a delete plus an add. With no base,
 * everything is added. Entries without an oid (symlinks, unmerged paths) are unchanged only when
 * both sides have none and the same type.
 */
export async function diffTrees(
  base: TreeReader | null,
  head: TreeReader,
  prefix: string,
): Promise<Change[]> {
  const before = new Map((base === null ? [] : await base.list(prefix)).map((e) => [e.path, e]));
  const after = new Map((await head.list(prefix)).map((e) => [e.path, e]));
  const changes: Change[] = [];
  for (const [path, h] of after) {
    const b = before.get(path);
    if (b === undefined) changes.push({ path, status: "added" });
    else if (!same(b, h)) changes.push({ path, status: "modified" });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, status: "deleted" });
  }
  return changes.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
