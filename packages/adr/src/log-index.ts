import { posix } from "node:path";
import {
  type Check,
  escapeMarkdown,
  type Git,
  type IndexSpec,
  indexAfterHint,
  indexBeforeHint,
  indexRerunHint,
  type IndexRun as LedgerIndexRun,
  type LogIndexJson,
  type LogLayout,
  logIndexCheck,
  renderIndex,
  renderLogIndex,
  runLogIndex,
  type TreeReader,
} from "@nikovirtala/ledger";
import { INDEX_ACTION, INDEX_TITLE } from "./commit-actions.js";
import type { AdrConfig } from "./config.js";
import { adrKind, type DecisionView } from "./kind.js";
import { type DecisionLog, type DecisionsRead, readDecisionsFrom } from "./log.js";
import type { WriteOptions } from "./write.js";

/** `adr index --json` (design 2b §4.5). */
export type IndexResultJson = LogIndexJson<"adr-index/v1">;

/**
 * What the recovery hint says about rerunning `adr index --commit` after `git commit` failed
 * (design 2b D5).
 */
export const INDEX_RERUN = indexRerunHint("adr");

/**
 * The step before the manual commit when a write's second index render failed after staging
 * (design 2b §4.5 step 4).
 */
export const INDEX_BEFORE = (root: string): string => indexBeforeHint("adr", "decisions", root);

/**
 * The step after the manual commit when the commit carried the index (design 2b D5, §4.5
 * step 5).
 */
export const INDEX_AFTER = (root: string): string => indexAfterHint("adr", "decisions", root);

const GROUPS: readonly { readonly heading: string; readonly statuses: readonly string[] }[] = [
  { heading: "Accepted", statuses: ["accepted"] },
  { heading: "Proposed", statuses: ["proposed"] },
  { heading: "Superseded and deprecated", statuses: ["superseded", "deprecated"] },
  { heading: "Rejected and withdrawn", statuses: ["rejected", "withdrawn"] },
];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * adr's index spec (01:209: active decisions first), built per render so that a superseded
 * decision's status can name its successor's display from `views`.
 */
export const DECISION_INDEX = (
  root: string,
  views: ReadonlyMap<string, DecisionView>,
): IndexSpec<DecisionView> => ({
  tool: "adr",
  title: "Architecture decisions",
  groups: GROUPS.map((g) => ({
    heading: g.heading,
    filter: (v: DecisionView) => g.statuses.includes(v.status),
  })),
  columns: [
    { heading: "Decision", cell: (v) => escapeMarkdown(v.display) },
    {
      heading: "Title",
      cell: (v) =>
        v.body_path === null
          ? escapeMarkdown(v.title)
          : `[${escapeMarkdown(v.title)}](${encodeURI(posix.relative(root, v.body_path))})`,
    },
    {
      heading: "Status",
      cell: (v) =>
        v.status === "superseded" && v.superseded_by !== null
          ? `superseded by ${escapeMarkdown(views.get(v.superseded_by)?.display ?? v.superseded_by)}`
          : v.status,
    },
    { heading: "Since", cell: (v) => v.status_at.slice(0, 10) },
  ],
  order: (a, b) =>
    (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY) ||
    cmp(a.status_at, b.status_at) ||
    cmp(a.id, b.id),
});

/** `DECISION_INDEX` for `views`, keyed by id so a superseded decision can name its successor. */
const decisionSpec = (root: string, views: readonly DecisionView[]): IndexSpec<DecisionView> =>
  DECISION_INDEX(root, new Map(views.map((v) => [v.id, v])));

/**
 * The index `tree` must hold: its decisions, numbered as they will be once the commit holding
 * `tree` (which builds on `history`: HEAD, a commit, or null on an unborn HEAD) is on main
 * (design 2b D2), with `[log] main_branch`'s numbers first; ledger's `renderLogIndex`. `null`
 * when the numbers can't be projected (a shallow clone whose `history` recorded none).
 */
export async function renderDecisionIndex(
  git: Git,
  o: {
    readonly layout: LogLayout;
    readonly adr: AdrConfig;
    readonly tree: TreeReader;
    readonly history: string | null;
  },
): Promise<string | null> {
  const { layout, adr } = o;
  return renderLogIndex(git, {
    kind: adrKind,
    layout,
    mainRef: adr.mainBranch,
    tree: o.tree,
    history: o.history,
    async views(tree, numbering) {
      const read = await readDecisionsFrom(tree, { layout, adr, numbering });
      return [...read.projection.views.values()];
    },
    spec: decisionSpec,
  });
}

/** The index table of `read`, as `index.md` holds it, numbered like every other read (`adr://index`). */
export function renderDecisionIndexText(read: DecisionsRead): string {
  const views = [...read.projection.views.values()];
  return renderIndex(decisionSpec(read.root, views), views, read.numbering);
}

const indexWords = (log: DecisionLog) =>
  ({
    tool: "adr",
    noun: "decision",
    render: (git: Git, at: { readonly tree: TreeReader; readonly history: string | null }) =>
      renderDecisionIndex(git, { layout: log.layout, adr: log.adr, ...at }),
  }) as const;

/**
 * The verify check that `<root>/index.md` is current (design 2b §4.5, "Freshness in verify"),
 * ledger's `logIndexCheck`: in staged mode, a stale staged copy that equals the work tree's render
 * names the unstaged decision files instead.
 */
export function decisionIndexCheck(log: DecisionLog): Check {
  return logIndexCheck(log, indexWords(log));
}

/** `adr index`'s result and whether the work-tree refresh after a commit changed a copy. */
export type IndexRun = LedgerIndexRun<"adr-index/v1">;

/**
 * `adr index` (design 2b §4.5) with what the text output needs; `indexDecisionLog` is the
 * library entry.
 */
export async function runDecisionIndex(
  log: DecisionLog,
  o: WriteOptions & { readonly check?: boolean } = {},
): Promise<IndexRun> {
  return runLogIndex(
    log,
    {
      ...indexWords(log),
      plural: "decisions",
      format: "adr-index/v1",
      index: log.adr.index,
      autoCommit: log.adr.autoCommit,
      commitSubject: log.adr.commitSubject,
      title: INDEX_TITLE,
      action: INDEX_ACTION,
    },
    o,
  );
}

/**
 * `adr index [--check] [--commit | --no-commit] [-m <message>]` (design 2b §4.5): renders
 * `<root>/index.md` and writes and stages it where the work tree or the index differ. With
 * `commit` (default `[policy] auto_commit`) it renders HEAD's tree and commits the file alone when
 * HEAD's copy differs, then refreshes the work tree's copy, which may include other decisions'
 * uncommitted entries. `check` writes nothing and reports `index/*` findings.
 */
export async function indexDecisionLog(
  log: DecisionLog,
  o: WriteOptions & { readonly check?: boolean } = {},
): Promise<IndexResultJson> {
  return (await runDecisionIndex(log, o)).doc;
}
