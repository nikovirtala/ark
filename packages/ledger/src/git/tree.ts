import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RefNotFoundError } from "../errors.js";
import { assertPath, assertRev, catFileBatch, type Git, requireWorkTree } from "./git.js";

export interface TreeEntry {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Git blob oid for regular files; `null` for symlinks and other entries. */
  readonly oid: string | null;
  readonly type: "file" | "symlink" | "other";
}

/** Read access to one tree of files: the work tree, the index, a commit or memory. */
export interface TreeReader {
  /** `"worktree"`, `"index"`, `"<ref> (<sha7>)"` or `"memory"`. */
  readonly label: string;
  /** The resolved commit for ref readers, else `null`. */
  readonly commit: string | null;
  /** Every entry at or under `prefix` (`""` for all), recursively, sorted by path. */
  list(prefix: string): Promise<TreeEntry[]>;
  read(path: string): Promise<Uint8Array | null>;
  readMany(paths: readonly string[]): Promise<Map<string, Uint8Array>>;
}

const encoder = new TextEncoder();

function comparePaths(a: TreeEntry, b: TreeEntry): number {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

function normalizePrefix(prefix: string): string {
  assertPath(prefix);
  return prefix.replace(/\/+$/, "");
}

function underPrefix(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

function typeOfMode(mode: string): TreeEntry["type"] {
  if (mode === "100644" || mode === "100755") return "file";
  if (mode === "120000") return "symlink";
  return "other";
}

async function readManyVia(
  paths: readonly string[],
  read: (path: string) => Promise<Uint8Array | null>,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const p of new Set(paths)) {
    const bytes = await read(p);
    if (bytes !== null) out.set(p, bytes);
  }
  return out;
}

async function readSpecs(
  git: Git,
  paths: readonly string[],
  spec: (path: string) => string,
): Promise<Map<string, Uint8Array>> {
  for (const p of paths) assertPath(p);
  const unique = [...new Set(paths)];
  const objects = await catFileBatch(git, unique.map(spec));
  const out = new Map<string, Uint8Array>();
  unique.forEach((p, i) => {
    const obj = objects[i];
    if (obj?.type === "blob") out.set(p, obj.bytes);
  });
  return out;
}

/**
 * The files on disk. `.gitignore` doesn't apply: a file under a log is part of it. Oids come from
 * one `git hash-object --stdin-paths` per `list`, which applies the same clean and eol filters as
 * `git add`, so they compare equal to the blobs a ref or the index holds.
 */
export function worktreeReader(git: Git): TreeReader {
  const root = requireWorkTree(git);

  async function walk(rel: string, out: { path: string; type: TreeEntry["type"] }[]) {
    const s = await lstat(join(root, rel)).catch(() => null);
    if (s === null) return;
    if (s.isDirectory()) {
      for (const name of await readdir(join(root, rel))) {
        if (rel === "" && name === ".git") continue;
        await walk(rel === "" ? name : `${rel}/${name}`, out);
      }
    } else if (s.isFile()) {
      out.push({ path: rel, type: rel.includes("\n") ? "other" : "file" });
    } else {
      out.push({ path: rel, type: s.isSymbolicLink() ? "symlink" : "other" });
    }
  }

  async function read(path: string): Promise<Uint8Array | null> {
    assertPath(path);
    try {
      const s = await lstat(join(root, path));
      if (s.isDirectory()) return null;
      return new Uint8Array(await readFile(join(root, path)));
    } catch {
      return null;
    }
  }

  return {
    label: "worktree",
    commit: null,
    async list(prefix) {
      const p = normalizePrefix(prefix);
      const found: { path: string; type: TreeEntry["type"] }[] = [];
      await walk(p, found);
      const files = found.filter((e) => e.type === "file").map((e) => e.path);
      const oids =
        files.length === 0
          ? []
          : Buffer.from(
              (await git.run(["hash-object", "--stdin-paths"], { input: `${files.join("\n")}\n` }))
                .stdout,
            )
              .toString("utf8")
              .split("\n");
      const oidOf = new Map(files.map((f, i) => [f, oids[i] ?? null]));
      return found
        .map((e): TreeEntry => ({ path: e.path, oid: oidOf.get(e.path) ?? null, type: e.type }))
        .sort(comparePaths);
    },
    read,
    readMany: (paths) => readManyVia(paths, read),
  };
}

/** The tree of the commit `ref` resolves to. Throws `RefNotFoundError` when it doesn't. */
export async function refReader(git: Git, ref: string): Promise<TreeReader> {
  assertRev(ref);
  const sha = await git.resolveCommit(ref);
  if (sha === null) throw new RefNotFoundError(ref);
  const readMany = (paths: readonly string[]) => readSpecs(git, paths, (p) => `${sha}:${p}`);
  return {
    label: `${ref} (${sha.slice(0, 7)})`,
    commit: sha,
    async list(prefix) {
      const p = normalizePrefix(prefix);
      const r = await git.run([
        "ls-tree",
        "-z",
        "-r",
        "--full-tree",
        "--end-of-options",
        sha,
        ...(p === "" ? [] : ["--", p]),
      ]);
      const entries: TreeEntry[] = [];
      for (const record of Buffer.from(r.stdout).toString("utf8").split("\0")) {
        const m = /^(\d+) (\S+) ([0-9a-f]+)\t(.*)$/s.exec(record);
        if (m === null) continue;
        const [, mode = "", , oid = "", path = ""] = m;
        if (!underPrefix(path, p)) continue;
        const type = typeOfMode(mode);
        entries.push({ path, oid: type === "file" ? oid : null, type });
      }
      return entries.sort(comparePaths);
    },
    async read(path) {
      return (await readMany([path])).get(path) ?? null;
    },
    readMany,
  };
}

/**
 * The index (`GIT_INDEX_FILE` applies). An unmerged path is listed once, as type `"other"`, and
 * isn't readable.
 */
export async function indexReader(git: Git): Promise<TreeReader> {
  requireWorkTree(git);
  const readMany = (paths: readonly string[]) => readSpecs(git, paths, (p) => `:0:${p}`);
  return {
    label: "index",
    commit: null,
    async list(prefix) {
      const p = normalizePrefix(prefix);
      const r = await git.run([
        "--literal-pathspecs",
        "ls-files",
        "-s",
        "-z",
        ...(p === "" ? [] : ["--", p]),
      ]);
      const byPath = new Map<string, TreeEntry>();
      for (const record of Buffer.from(r.stdout).toString("utf8").split("\0")) {
        const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(record);
        if (m === null) continue;
        const [, mode = "", oid = "", stage = "", path = ""] = m;
        if (!underPrefix(path, p)) continue;
        if (stage !== "0") {
          byPath.set(path, { path, oid: null, type: "other" });
          continue;
        }
        const type = typeOfMode(mode);
        byPath.set(path, { path, oid: type === "file" ? oid : null, type });
      }
      return [...byPath.values()].sort(comparePaths);
    },
    async read(path) {
      return (await readMany([path])).get(path) ?? null;
    },
    readMany,
  };
}

/** An in-memory tree whose oids follow git's blob formula, for tests and pure verification. */
export class MemoryTree implements TreeReader {
  readonly label = "memory";
  readonly commit = null;
  readonly #files: Map<string, { bytes: Uint8Array; oid: string }>;

  constructor(
    files: Readonly<Record<string, string | Uint8Array>>,
    o: { readonly objectFormat?: "sha1" | "sha256" } = {},
  ) {
    const algorithm = o.objectFormat ?? "sha1";
    this.#files = new Map(
      Object.entries(files).map(([path, content]) => {
        const bytes = typeof content === "string" ? encoder.encode(content) : content;
        const oid = createHash(algorithm)
          .update(`blob ${bytes.byteLength}\0`)
          .update(bytes)
          .digest("hex");
        return [path, { bytes, oid }];
      }),
    );
  }

  async list(prefix: string): Promise<TreeEntry[]> {
    const p = normalizePrefix(prefix);
    return [...this.#files]
      .filter(([path]) => underPrefix(path, p))
      .map(([path, f]): TreeEntry => ({ path, oid: f.oid, type: "file" }))
      .sort(comparePaths);
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.#files.get(path)?.bytes ?? null;
  }

  async readMany(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
    return readManyVia(paths, (p) => this.read(p));
  }
}
