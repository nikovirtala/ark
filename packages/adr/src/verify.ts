import {
  type Check,
  type Finding,
  foldChecks,
  gitTemplates,
  templateHistoryRef,
  type VerifyMode,
  verifyLog,
} from "@nikovirtala/ledger";
import { adrKind } from "./kind.js";
import type { DecisionLog } from "./log.js";

/**
 * Every phase-1 check for the log: ledger's mechanical and fold checks with adr's actor policy,
 * and template lint against the templates in the head tree and, for older versions, the history
 * of `historyRef`.
 */
export function adrChecks(log: DecisionLog, historyRef: string | null): readonly Check[] {
  return foldChecks(adrKind, {
    options: { acceptRequiresHuman: log.adr.acceptRequiresHuman },
    templates: gitTemplates(log.git, { historyRef }),
  });
}

/** Verifies the decision log in `mode` (staged, range or full) with `adrChecks`. */
export async function verifyDecisions(log: DecisionLog, mode: VerifyMode): Promise<Finding[]> {
  return verifyLog({
    git: log.git,
    kind: adrKind,
    layout: log.layout,
    mode,
    checks: adrChecks(log, await templateHistoryRef(log.git, mode)),
  });
}
