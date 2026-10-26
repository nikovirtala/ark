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
import { type IssueStatus, type IssueView, issueKind } from "./kind.js";
import { type IssueLog, type IssuesRead, readNotes } from "./log.js";
import { compareIssues, type NumberingJson, numberingJson, stateHeader } from "./views.js";

/** One issue that concerns a path in `issues-for/v1`. */
export interface IssueForJson {
  readonly id: string;
  readonly display: string;
  readonly title: string;
  readonly state: IssueStatus;
  readonly canonical: string | null;
  readonly blocked: boolean;
  /** The state header's warning: a duplicate, closed or blocked issue; `null` if nothing. */
  readonly warning: string | null;
  /** The globs that matched, then the anchor lines. */
  readonly via: readonly ScopeVia[];
}

/** An anchor naming no issue of this log. */
export interface UnresolvedIssueAnchorJson {
  /** The id, or `<source>:<id>` for a qualified anchor. */
  readonly ref: string;
  readonly line: number;
  readonly reason: "not-found" | "other-log";
}

/** `issues for <path>… --json` (adr-for/v1's shape). */
export interface IssuesForJson {
  readonly format: "issues-for/v1";
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  readonly paths: readonly {
    readonly path: string;
    /** In the index, or in the `--ref` tree. */
    readonly tracked: boolean;
    readonly issues: readonly IssueForJson[];
    readonly unresolved: readonly UnresolvedIssueAnchorJson[];
  }[];
  /** The read's findings of the listed issues and of the log as a whole. */
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

const MAX_PATHS = 100;
const MAX_PATH_LENGTH = 4096;
const STATE_ORDER: readonly IssueStatus[] = ["in-progress", "open", "closed"];
const ACTIVE: ReadonlySet<string> = new Set(issueKind.def.scope?.activeIn ?? []);

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
 * Which issues concern each path (02 `issues for`): scope globs of open and in-progress issues,
 * and `issue:<id>` comment anchors of open and in-progress issues (of any issue with `all`), read
 * from the work tree or, with a `--ref` log, that commit. Paths are relative to `o.cwd` (default
 * the repository root); directories and paths outside the repository are `UsageError`s, as in
 * adr's `decisionsFor`.
 */
export async function issuesFor(
  read: IssuesRead,
  log: IssueLog,
  o: { readonly paths: readonly string[]; readonly cwd?: string; readonly all?: boolean },
): Promise<IssuesForJson> {
  const root = log.git.root;
  if (root === null) throw new UsageError("issues for needs a work tree");
  if (o.paths.length === 0 || o.paths.length > MAX_PATHS) {
    throw new UsageError(`issues for takes 1 to ${MAX_PATHS} paths`);
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
    let directory = path === "";
    if (!directory && read.ref === null) {
      const st = await lstat(join(root, path)).catch(() => null);
      directory = st === null ? await hasUnder(await indexed(), path) : st.isDirectory();
    } else if (!directory) {
      directory = await hasUnder(read.tree, path);
    }
    if (directory) {
      throw new UsageError(
        `${given} is a directory; issues for takes file paths, for example issues for $(git ls-files ${given})`,
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
    keyword: read.issues.anchorKeyword,
    tree: atRef ? { commit: read.commit as string } : "worktree",
    paths,
    excludeDirs: [read.layout.root],
    exclude: read.issues.anchorExclude,
  });
  const views = read.projection.views;
  const lookup = scopeLookup({
    subjects: [...views.values()]
      .filter((v) => ACTIVE.has(v.state))
      .map((v) => ({ id: v.id, globs: v.applies_to })),
    anchors,
  });
  const shown = (v: IssueView) => o.all === true || ACTIVE.has(v.state);

  const listed = new Set<string>();
  const out = paths.map((path) => {
    const issues: { view: IssueView; via: readonly ScopeVia[] }[] = [];
    const unresolved: UnresolvedIssueAnchorJson[] = [];
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
      if (!shown(view)) continue;
      issues.push({ view, via: m.via });
      listed.add(view.id);
    }
    issues.sort(
      (a, b) =>
        STATE_ORDER.indexOf(a.view.state) - STATE_ORDER.indexOf(b.view.state) ||
        compareIssues(a.view, b.view),
    );
    unresolved.sort((a, b) => a.line - b.line);
    return {
      path,
      tracked: tracked.has(path),
      issues: issues.map(
        ({ view: v, via }): IssueForJson => ({
          id: v.id,
          display: v.display,
          title: v.title,
          state: v.state,
          canonical: v.canonical,
          blocked: v.blocked,
          warning: stateHeader(v, read).warning,
          via,
        }),
      ),
      unresolved,
    };
  });
  return {
    format: "issues-for/v1",
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    paths: out,
    findings: read.findings.filter((f) => f.subject === null || listed.has(f.subject)),
    notes: readNotes(read),
  };
}
