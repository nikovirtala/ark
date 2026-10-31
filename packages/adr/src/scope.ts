import {
  type Finding,
  lookupPaths,
  type ScopeVia,
  type UnresolvedAnchor,
  withGitOperation,
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
export type UnresolvedAnchorJson = UnresolvedAnchor;

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

/** Statuses whose globs govern code; rejected and withdrawn decisions were never in force. */
const GLOBS_APPLY: ReadonlySet<DecisionStatus> = new Set([
  "proposed",
  "accepted",
  "deprecated",
  "superseded",
]);
/** The order `adr for` and `adr search` list statuses in: in force first. */
export const STATUS_ORDER: readonly DecisionStatus[] = [
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
  return withGitOperation(async () => {
    const views = read.projection.views;
    const found = await lookupPaths(log.git, {
      tool: "adr",
      tree: read.tree,
      ref: read.ref,
      commit: read.commit,
      ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
      paths: o.paths,
      keyword: read.adr.anchorKeyword,
      excludeDirs: [read.layout.root],
      exclude: read.adr.anchorExclude,
      globSubjects: [...views.values()]
        .filter((v) => GLOBS_APPLY.has(v.status))
        .map((v) => ({ id: v.id, globs: v.applies_to })),
      known: (id) => views.get(id) !== undefined,
    });

    const listed = new Set<string>();
    const out = found.map(({ path, tracked, matches, unresolved }) => {
      const decisions: { view: DecisionView; via: readonly ScopeVia[] }[] = [];
      for (const m of matches) {
        const view = views.get(m.id);
        if (view === undefined) continue;
        decisions.push({ view, via: m.via });
        listed.add(view.id);
      }
      decisions.sort((a, b) => compareFor(a.view, b.view));
      return {
        path,
        tracked,
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
  });
}
