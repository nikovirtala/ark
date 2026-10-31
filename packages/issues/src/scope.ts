import {
  type Finding,
  lookupPaths,
  type ScopeVia,
  type UnresolvedAnchor,
  withGitOperation,
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
export type UnresolvedIssueAnchorJson = UnresolvedAnchor;

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

const STATE_ORDER: readonly IssueStatus[] = ["in-progress", "open", "closed"];
const ACTIVE: ReadonlySet<string> = new Set(issueKind.def.scope?.activeIn ?? []);

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
  return withGitOperation(async () => {
    const views = read.projection.views;
    const found = await lookupPaths(log.git, {
      tool: "issues",
      tree: read.tree,
      ref: read.ref,
      commit: read.commit,
      ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
      paths: o.paths,
      keyword: read.issues.anchorKeyword,
      excludeDirs: [read.layout.root],
      exclude: read.issues.anchorExclude,
      globSubjects: [...views.values()]
        .filter((v) => ACTIVE.has(v.state))
        .map((v) => ({ id: v.id, globs: v.applies_to })),
      known: (id) => views.get(id) !== undefined,
    });
    const shown = (v: IssueView) => o.all === true || ACTIVE.has(v.state);

    const listed = new Set<string>();
    const out = found.map(({ path, tracked, matches, unresolved }) => {
      const issues: { view: IssueView; via: readonly ScopeVia[] }[] = [];
      for (const m of matches) {
        const view = views.get(m.id);
        if (view === undefined) continue;
        if (!shown(view)) continue;
        issues.push({ view, via: m.via });
        listed.add(view.id);
      }
      issues.sort(
        (a, b) =>
          STATE_ORDER.indexOf(a.view.state) - STATE_ORDER.indexOf(b.view.state) ||
          compareIssues(a.view, b.view),
      );
      return {
        path,
        tracked,
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
  });
}
