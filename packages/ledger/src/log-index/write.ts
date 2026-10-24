import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InvalidArgumentError } from "../errors.js";
import { assertPath, type Git, requireWorkTree } from "../git/git.js";

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Writes a generated index to the repo-relative `path` in the work tree, atomically: a temp file
 * next to it, then a rename (mode 0o644). Returns `false`, touching nothing, when the file already
 * holds `text`. fs errors propagate as they are.
 */
export async function writeIndexFile(git: Git, path: string, text: string): Promise<boolean> {
  const root = requireWorkTree(git);
  assertPath(path);
  const segments = path.split("/");
  if (path.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new InvalidArgumentError(`not a repo-relative file path: ${JSON.stringify(path)}`);
  }
  const full = join(root, path);
  const bytes = new TextEncoder().encode(text);
  const current = await readBytes(full);
  if (current !== null && Buffer.from(current).equals(bytes)) return false;
  await mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.ark-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, full);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return true;
}
