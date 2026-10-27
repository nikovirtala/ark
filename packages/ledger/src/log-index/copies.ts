/**
 * Helpers for keeping a generated index's work-tree, staged and HEAD copies in step, shared by
 * the tools whose writes refresh a committed `index.md` (adr 2b, issues).
 */
import type { Git } from "../git/git.js";
import {
  indexReader,
  MemoryTree,
  refReader,
  type TreeReader,
  worktreeReader,
} from "../git/tree.js";
import { writeIndexFile } from "./write.js";

const encoder = new TextEncoder();

/** Whether `bytes` (null: absent) hold exactly `text`. */
export function holdsText(bytes: Uint8Array | null, text: string): boolean {
  if (bytes === null) return false;
  const want = encoder.encode(text);
  return bytes.byteLength === want.byteLength && bytes.every((x, i) => x === want[i]);
}

/** HEAD's copy of `path`; `null` when it is absent or HEAD is unborn. */
export async function headBytes(git: Git, path: string): Promise<Uint8Array | null> {
  const head = await git.resolveCommit("HEAD");
  return head === null ? null : (await refReader(git, head)).read(path);
}

/** HEAD's tree, or an empty tree on an unborn HEAD. */
export async function headTree(git: Git, head: string | null): Promise<TreeReader> {
  return head === null ? new MemoryTree({}) : refReader(git, head);
}

/**
 * Brings the work-tree copy of `path` to `text` (atomically, when it differs) and reports whether
 * the staged copy differs, so the caller stages it. `old` is the work-tree copy before the write
 * (`null` when absent), for rollback.
 */
export async function writeIndexCopy(
  git: Git,
  path: string,
  text: string,
): Promise<{ readonly wrote: boolean; readonly old: Uint8Array | null; readonly stage: boolean }> {
  const old = await worktreeReader(git).read(path);
  const wrote = !holdsText(old, text) && (await writeIndexFile(git, path, text));
  const stage = !holdsText(await (await indexReader(git)).read(path), text);
  return { wrote, old, stage };
}

/** The first line of an error's message, for notes and headlines. */
export const firstLine = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";

/** `tree` without the paths in `gone` (a staged deletion in a commit's `only` list). */
export function withoutPaths(tree: TreeReader, gone: ReadonlySet<string>): TreeReader {
  if (gone.size === 0) return tree;
  return {
    label: tree.label,
    commit: null,
    list: async (prefix) => (await tree.list(prefix)).filter((e) => !gone.has(e.path)),
    read: async (path) => (gone.has(path) ? null : tree.read(path)),
    readMany: (paths) => tree.readMany(paths.filter((p) => !gone.has(p))),
  };
}
