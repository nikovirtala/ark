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
import { readSourceLogs } from "./sources.js";
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
 * Verifies the issue log in `mode` (staged, range or full) with `issuesChecks`. The decision log
 * is read from the tree `log` was opened on, so open it with the index reader for `staged`.
 */
export async function verifyIssues(log: IssueLog, mode: VerifyMode): Promise<Finding[]> {
  return verifyLog({
    git: log.git,
    kind: issueKind,
    layout: log.layout,
    mode,
    checks: issuesChecks(log, await templateHistoryRef(log.git, mode), await readSourceLogs(log)),
  });
}
