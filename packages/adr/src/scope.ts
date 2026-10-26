import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type Finding,
  indexReader,
  type ScopeVia,
  scanAnchors,
  scopeLookup,
  type TreeReader,
  UsageError,
} from "@nikovirtala/ledger";
import type { DecisionStatus, DecisionView } from "./kind.js";
import { type DecisionLog, type DecisionsRead, listingNotes } from "./log.js";
import { type NumberingJson, numberingJson, stateHeader } from "./views.js";

/** One decision that governs a path in `adr-for/v1` (design §6.9). */
export interface DecisionForJson {
  readonly id: string;
  readonly display: string;
  readonly title: string;
  readonly status: DecisionStatus;
  readonly effective: string | null;
  /** What to know before applying it: superseded, deprecated, never in force; `null` if nothing. */
  readonly warning: string | null;
  /** The globs that matched, then the anchor lines. */
  readonly via: readonly ScopeVia[];
}

/** An anchor naming no decision of this log. */
export interface UnresolvedAnchorJson {
  /** The id, or `<source>:<id>` for a qualified anchor. */
  readonly ref: string;
  readonly line: number;
  readonly reason: "not-found" | "other-log";
}

/** `adr for <path>… --json` (design §6.9). */
export interface DecisionsForJson {
  readonly format: "adr-for/v1";
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  readonly paths: readonly {
    readonly path: string;
    /** In the index, or in the `--ref` tree. */
    readonly tracked: boolean;
    readonly decisions: readonly DecisionForJson[];
    readonly unresolved: readonly UnresolvedAnchorJson[];
  }[];
  /** The read's findings of the listed decisions and of the log as a whole. */
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

const MAX_PATHS = 100;
const MAX_PATH_LENGTH = 4096;
/** Statuses whose globs govern code; rejected and withdrawn decisions were never in force. */
const GLOBS_APPLY: ReadonlySet<DecisionStatus> = new Set([
  "proposed",
  "accepted",
  "deprecated",
  "superseded",
]);
const STATUS_ORDER: readonly DecisionStatus[] = [
  "accepted",
  "proposed",
  "deprecated",
  "superseded",
  "rejected",
  "withdrawn",
];

/** Accepted first (design §6.9 step 5); within a status by number, then by id. */
function compareFor(a: DecisionView, b: DecisionView): number {
  const s = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (s !== 0) return s;
  if (a.number !== null || b.number !== null) {
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    return a.number - b.number;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
 * Which decisions govern each path (design §6.9): globs of decisions that were ever in force, and
 * comment anchors of any decision, read from the work tree or, with a `--ref` log, that commit.
 * Paths are relative to `o.cwd` (default the repository root); directories and paths outside the
 * repository are `UsageError`s. Paths need not be tracked.
 */
export async function decisionsFor(
  read: DecisionsRead,
  log: DecisionLog,
  o: { readonly paths: readonly string[]; readonly cwd?: string },
): Promise<DecisionsForJson> {
  const root = log.git.root;
  if (root === null) throw new UsageError("adr for needs a work tree");
  if (o.paths.length === 0 || o.paths.length > MAX_PATHS) {
    throw new UsageError(`adr for takes 1 to ${MAX_PATHS} paths`);
  }
  let index: Promise<TreeReader> | null = null;
  const indexed = () => {
    index ??= indexReader(log.git);
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
    if (!directory && read.ref === null) {
      const st = await lstat(join(root, path)).catch(() => null);
      directory = st === null ? await hasUnder(await indexed(), path) : st.isDirectory();
    } else if (!directory) {
      directory = await hasUnder(read.tree, path);
    }
    if (directory) {
      throw new UsageError(
        `${given} is a directory; adr for takes file paths, for example adr for $(git ls-files ${given})`,
      );
    }
    if (!paths.includes(path)) paths.push(path);
  }

  const atRef = read.ref !== null && read.commit !== null;
  const trackedIn = atRef ? read.tree : await indexed();
  const tracked = new Set<string>();
  for (const p of paths) {
    if ((await trackedIn.list(p)).some((e) => e.path === p)) tracked.add(p);
  }
  const anchors = await scanAnchors(log.git, {
    keyword: read.adr.anchorKeyword,
    tree: atRef ? { commit: read.commit as string } : "worktree",
    paths,
    excludeDirs: [read.layout.root],
    exclude: read.adr.anchorExclude,
  });
  const views = read.projection.views;
  const lookup = scopeLookup({
    subjects: [...views.values()]
      .filter((v) => GLOBS_APPLY.has(v.status))
      .map((v) => ({ id: v.id, globs: v.applies_to })),
    anchors,
  });

  const listed = new Set<string>();
  const out = paths.map((path) => {
    const decisions: { view: DecisionView; via: readonly ScopeVia[] }[] = [];
    const unresolved: UnresolvedAnchorJson[] = [];
    for (const m of lookup(path)) {
      const view = m.source === null ? views.get(m.id) : undefined;
      if (view === undefined) {
        for (const v of m.via) {
          if (v.type !== "anchor") continue;
          unresolved.push({
            ref: m.source === null ? m.id : `${m.source}:${m.id}`,
            line: v.line,
            reason: m.source === null ? "not-found" : "other-log",
          });
        }
        continue;
      }
      decisions.push({ view, via: m.via });
      listed.add(view.id);
    }
    decisions.sort((a, b) => compareFor(a.view, b.view));
    unresolved.sort((a, b) => a.line - b.line);
    return {
      path,
      tracked: tracked.has(path),
      decisions: decisions.map(
        ({ view: v, via }): DecisionForJson => ({
          id: v.id,
          display: v.display,
          title: v.title,
          status: v.status,
          effective: v.effective,
          warning: stateHeader(v, read).warning,
          via,
        }),
      ),
      unresolved,
    };
  });
  return {
    format: "adr-for/v1",
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    paths: out,
    findings: read.findings.filter((f) => f.subject === null || listed.has(f.subject)),
    notes: listingNotes(read),
  };
}
