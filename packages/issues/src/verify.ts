import { adrKind } from "@nikovirtala/adr/kind";
import {
  anchorCheck,
  type Check,
  type Finding,
  type FoldedLogOf,
  foldChecks,
  gitTemplates,
  type SourceStatus,
  scopeGlobCheck,
  sourceFindings,
  templateHistoryRef,
  type VerifyMode,
  verifyLog,
  withGitOperation,
} from "@nikovirtala/ledger";
import { issueKind, type SourceLog } from "./kind.js";
import type { IssueLog } from "./log.js";
import { issueIndexCheck } from "./log-index.js";
import { type DecisionLogRead, readDecisionLog, readIssueSources } from "./sources.js";
import { staleAnchorCheck } from "./stale-anchors.js";

/**
 * Every check of an issue log in this version: ledger's mechanical and fold checks with the
 * kind's invariants and relate under the config's policy and `sources` (the local decision log),
 * and template lint of open and in-progress issues against the templates in the head tree and,
 * for older versions, the history of `historyRef`; the checks over code of 02's CI table (scope
 * globs of in-progress issues, `scope/anchor-missing`, `issue/stale-anchor`); and with `[log]
 * index = "committed"`, the freshness of `<root>/index.md`.
 */
export function issuesChecks(
  log: IssueLog,
  historyRef: string | null,
  sources: ReadonlyMap<string, SourceLog>,
  statuses: readonly SourceStatus[] = [],
): readonly Check[] {
  return [
    ...foldChecks(issueKind, {
      options: {
        closeRequiresHuman: log.issues.closeRequiresHuman,
        mcpCanClose: log.issues.mcpCanClose,
        exclusive: log.issues.exclusive,
        sources,
      },
      templates: gitTemplates(log.git, { historyRef }),
    }),
    scopeGlobCheck(),
    anchorCheck({ keyword: log.issues.anchorKeyword, exclude: log.issues.anchorExclude }),
    staleAnchorCheck(log),
    sourcesCheck(log, statuses),
    ...(log.issues.index === "committed" ? [issueIndexCheck(log)] : []),
  ];
}

/** The source names that qualified references in a folded issue log name. */
export function referencedSources(head: FoldedLogOf<typeof issueKind>): Set<string> {
  const out = new Set<string>();
  const add = (ref: string | null | undefined) => {
    const at = ref?.indexOf(":") ?? -1;
    if (ref !== null && ref !== undefined && at > 0) out.add(ref.slice(0, at));
  };
  for (const s of head.subjects.values()) {
    for (const l of s.state?.links ?? []) add(l.to);
    for (const { event } of s.applied) {
      if (event.type === "opened") add(event.data.parent);
      else if (event.type === "closed") add(event.data.of);
    }
  }
  return out;
}

/**
 * `sources/not-fetched` (warning) once per uncached `[[sources]]` entry that a qualified reference
 * names. It runs in every scope, because it is about the log, not about one issue.
 */
function sourcesCheck(log: IssueLog, statuses: readonly SourceStatus[]): Check {
  return {
    id: "issue-sources",
    async run(ctx) {
      const head = ctx.folded?.head;
      if (head === undefined || statuses.length === 0) return [];
      return sourceFindings(statuses, {
        tool: "issues",
        file: log.configPath,
        referenced: referencedSources(head as FoldedLogOf<typeof issueKind>),
      });
    },
  };
}

/**
 * The inputs outside the issue events that issues' checks read: both candidate config paths (so
 * adding a config counts), the log's templates, and the repository's decision log with both of
 * adr's config paths (`docs/adr` when there is none in the tree, so deleting it counts too). A
 * staged change to one widens `verify --staged` to every issue: a policy, label, scope, index or
 * template change, or a decision rejected or superseded, can make an unchanged issue fail.
 */
export function issueVerifyInputs(log: IssueLog, decisions: DecisionLogRead | null): string[] {
  const root = log.layout.root;
  const adr = decisions?.root ?? adrKind.def.defaultRoot;
  return [
    "issues.toml",
    `${root}/issues.toml`,
    `${root}/templates/`,
    `${adr}/`,
    "adr.toml",
    `${adr}/adr.toml`,
  ];
}

/**
 * Verifies the issue log in `mode` (staged, range or full) with `issuesChecks`, reading the
 * sources from the local cache only. The decision log is read from the tree `log` was opened on,
 * so open it with the index reader for `staged`.
 */
export async function verifyIssues(log: IssueLog, mode: VerifyMode): Promise<Finding[]> {
  return withGitOperation(async () => {
    const decisions = await readDecisionLog(log);
    const sources = await readIssueSources(log, { decisions, fetch: "cache" });
    return verifyLog({
      git: log.git,
      kind: issueKind,
      layout: log.layout,
      mode,
      checks: issuesChecks(
        log,
        await templateHistoryRef(log.git, mode),
        sources.logs,
        sources.statuses,
      ),
      widenOn: issueVerifyInputs(log, decisions),
    });
  });
}
