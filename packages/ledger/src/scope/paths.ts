/** The path handling behind `<tool> for` (design §6.9): which subjects govern each given path. */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.js";
import type { Git } from "../git/git.js";
import { withGitOperation } from "../git/operation.js";
import { indexReader, type TreeReader } from "../git/tree.js";
import { scanAnchors } from "./anchors.js";
import { type ScopeMatch, scopeLookup } from "./lookup.js";

const MAX_PATHS = 100;
const MAX_PATH_LENGTH = 4096;

/** An anchor naming no subject of this log. */
export interface UnresolvedAnchor {
  /** The id, or `<source>:<id>` for a qualified anchor. */
  readonly ref: string;
  readonly line: number;
  readonly reason: "not-found" | "other-log";
}

/** One given path's lookup. */
export interface PathLookup {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** In the index, or in the ref's tree. */
  readonly tracked: boolean;
  /** The subjects of this log that govern the path, in `scopeLookup` order. */
  readonly matches: readonly ScopeMatch[];
  /** Anchors to another log's subjects or to unknown ids, by line. */
  readonly unresolved: readonly UnresolvedAnchor[];
}

/** `path` (relative to `cwd`) as a repo-relative POSIX path; `UsageError` outside the work tree. */
async function repoPath(root: string, cwd: string, path: string): Promise<string> {
  if (path.length > MAX_PATH_LENGTH) {
    throw new UsageError(`a path can be at most ${MAX_PATH_LENGTH} characters`);
  }
  const base = await realpath(cwd).catch(() => cwd);
  const rel = relative(root, resolve(base, path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UsageError(`${path} is outside the repository`);
  }
  return rel.split(sep).join("/");
}

/**
 * Which subjects govern each of 1 to 100 `paths` (relative to `cwd`, default the repository root),
 * deduplicated in the given order: globs of `globSubjects`, and `keyword` comment anchors read from
 * the work tree or, when `ref` and `commit` are set, that commit. A local anchor to an id `known`
 * rejects is `not-found`, a qualified one `other-log`. Directories, paths outside the repository,
 * too long paths and a handle without a work tree are `UsageError`s naming `tool`. Paths need not
 * be tracked.
 */
export async function lookupPaths(
  git: Git,
  o: {
    /** The tool's name in messages, such as `adr`. */
    readonly tool: string;
    /** The log's tree: the work tree, or the ref's. */
    readonly tree: TreeReader;
    readonly ref: string | null;
    readonly commit: string | null;
    readonly cwd?: string;
    readonly paths: readonly string[];
    readonly keyword: string;
    readonly exclude?: readonly string[];
    readonly excludeDirs?: readonly string[];
    /** The subjects whose globs apply. */
    readonly globSubjects: readonly { readonly id: string; readonly globs: readonly string[] }[];
    /** Whether `id` is any subject of this log. */
    readonly known: (id: string) => boolean;
  },
): Promise<PathLookup[]> {
  return withGitOperation(async () => {
    const root = git.root;
    if (root === null) throw new UsageError(`${o.tool} for needs a work tree`);
    if (o.paths.length === 0 || o.paths.length > MAX_PATHS) {
      throw new UsageError(`${o.tool} for takes 1 to ${MAX_PATHS} paths`);
    }
    let index: Promise<TreeReader> | null = null;
    const indexed = () => {
      index ??= indexReader(git);
      return index;
    };
    const hasUnder = async (tree: TreeReader, path: string) =>
      (await tree.list(path)).some((e) => e.path !== path);
    const paths: string[] = [];
    for (const given of o.paths) {
      const path = await repoPath(root, o.cwd ?? root, given);
      // A work-tree directory is found with lstat, before anything is listed or hashed (a symlink
      // is a file); a path missing from the work tree is a directory when the index has paths under
      // it. At a ref, the commit's tree is listed, which hashes nothing.
      let directory = path === "";
      if (!directory && o.ref === null) {
        const st = await lstat(join(root, path)).catch(() => null);
        directory = st === null ? await hasUnder(await indexed(), path) : st.isDirectory();
      } else if (!directory) {
        directory = await hasUnder(o.tree, path);
      }
      if (directory) {
        throw new UsageError(
          `${given} is a directory; ${o.tool} for takes file paths, for example ${o.tool} for $(git ls-files ${given})`,
        );
      }
      if (!paths.includes(path)) paths.push(path);
    }

    const atRef = o.ref !== null && o.commit !== null;
    const trackedIn = atRef ? o.tree : await indexed();
    const tracked = new Set<string>();
    for (const p of paths) {
      if ((await trackedIn.list(p)).some((e) => e.path === p)) tracked.add(p);
    }
    const anchors = await scanAnchors(git, {
      keyword: o.keyword,
      tree: atRef ? { commit: o.commit as string } : "worktree",
      paths,
      ...(o.excludeDirs === undefined ? {} : { excludeDirs: o.excludeDirs }),
      ...(o.exclude === undefined ? {} : { exclude: o.exclude }),
    });
    const lookup = scopeLookup({ subjects: o.globSubjects, anchors });

    return paths.map((path): PathLookup => {
      const matches: ScopeMatch[] = [];
      const unresolved: UnresolvedAnchor[] = [];
      for (const m of lookup(path)) {
        if (m.source === null && o.known(m.id)) {
          matches.push(m);
          continue;
        }
        for (const v of m.via) {
          if (v.type !== "anchor") continue;
          unresolved.push({
            ref: m.source === null ? m.id : `${m.source}:${m.id}`,
            line: v.line,
            reason: m.source === null ? "not-found" : "other-log",
          });
        }
      }
      unresolved.sort((a, b) => a.line - b.line);
      return { path, tracked: tracked.has(path), matches, unresolved };
    });
  });
}
