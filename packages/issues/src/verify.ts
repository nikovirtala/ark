import { adrKind } from "@nikovirtala/adr/kind";
import {
  anchorCheck,
  type Check,
  type Finding,
  foldChecks,
  gitTemplates,
  scopeGlobCheck,
  templateHistoryRef,
  type VerifyMode,
  verifyLog,
} from "@nikovirtala/ledger";
import { issueKind, type SourceLog } from "./kind.js";
import type { IssueLog } from "./log.js";
import { issueIndexCheck } from "./log-index.js";
import { type DecisionLogRead, readDecisionLog, sourceLogsOf } from "./sources.js";
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
    ...(log.issues.index === "committed" ? [issueIndexCheck(log)] : []),
  ];
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
 * Verifies the issue log in `mode` (staged, range or full) with `issuesChecks`. The decision log
 * is read from the tree `log` was opened on, so open it with the index reader for `staged`.
 */
export async function verifyIssues(log: IssueLog, mode: VerifyMode): Promise<Finding[]> {
  const decisions = await readDecisionLog(log);
  return verifyLog({
    git: log.git,
    kind: issueKind,
    layout: log.layout,
    mode,
    checks: issuesChecks(
      log,
      await templateHistoryRef(log.git, mode),
      sourceLogsOf(decisions, log.config),
    ),
    widenOn: issueVerifyInputs(log, decisions),
  });
}
