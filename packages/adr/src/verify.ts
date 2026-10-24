import {
  anchorCheck,
  type Check,
  type CheckContext,
  type Finding,
  type FoldedLogOf,
  finding,
  foldChecks,
  type GovernedChange,
  gitTemplates,
  governedChanges,
  narrowedScopes,
  projectLog,
  scopeGlobCheck,
  templateHistoryRef,
  type VerifyMode,
  verifyLog,
} from "@nikovirtala/ledger";
import { adrKind, type DecisionView } from "./kind.js";
import { type DecisionLog, numberDecisions } from "./log.js";
import { decisionIndexCheck } from "./log-index.js";

/** At most this many paths are named in a `decision/scope-narrowed` message. */
const NARROWED_PATHS = 3;

/** The head's decision views with the read's numbering, for the displays in messages. */
async function headViews(
  log: DecisionLog,
  ctx: CheckContext,
): Promise<ReadonlyMap<string, DecisionView>> {
  const head = ctx.folded?.head;
  if (head === undefined) return new Map();
  return projectLog(adrKind, head as FoldedLogOf<typeof adrKind>, {
    numbering: await numberDecisions(log),
  }).views;
}

/**
 * `decision/governed-by-inactive` (`[verify] governed_by_inactive`, default warning): a changed
 * code file that a superseded or deprecated decision governs, by glob or anchor (01:366).
 */
function governedByInactive(log: DecisionLog): Check {
  return {
    id: "decision-governed-by-inactive",
    async run(ctx) {
      const changes = await governedChanges(ctx, {
        keyword: log.adr.anchorKeyword,
        exclude: log.adr.anchorExclude,
        statuses: ["superseded", "deprecated"],
      });
      if (changes.length === 0) return [];
      const views = await headViews(log, ctx);
      const display = (id: string) => views.get(id)?.display ?? id;
      const message = (c: GovernedChange): string => {
        const what = `${c.path} is governed by ${display(c.subject)}`;
        if (c.status === "deprecated") {
          return `${what}, which is deprecated; check whether the change still needs it`;
        }
        const next = views.get(c.subject)?.superseded_by ?? null;
        return next === null
          ? `${what}, which is superseded; check the change against its successor`
          : `${what}, which is superseded by ${display(next)}; check the change against ${display(next)}`;
      };
      return changes.map((c) =>
        finding({
          severity: log.adr.governedByInactive,
          rule: "decision/governed-by-inactive",
          message: message(c),
          file: c.path,
          subject: c.subject,
        }),
      );
    },
  };
}

/**
 * `decision/scope-narrowed` (warning): an accepted decision whose new scope stops covering files
 * that still exist (01:367), which calls for a check against its Scope section.
 */
function scopeNarrowed(log: DecisionLog): Check {
  return {
    id: "decision-scope-narrowed",
    async run(ctx) {
      const narrowed = await narrowedScopes(ctx, { statuses: ["accepted"] });
      if (narrowed.length === 0) return [];
      const views = await headViews(log, ctx);
      return narrowed.map((n) => {
        const count = n.lost.length;
        const files = count === 1 ? "1 file that still exists" : `${count} files that still exist`;
        const named = n.lost.slice(0, NARROWED_PATHS).join(", ");
        const more = count > NARROWED_PATHS ? ", …" : "";
        return finding({
          severity: "warning",
          rule: "decision/scope-narrowed",
          message: `${views.get(n.subject)?.display ?? n.subject}'s scope no longer covers ${files} (${named}${more}); check the change against its Scope section`,
          file: n.file,
          subject: n.subject,
        });
      });
    },
  };
}

/**
 * Every check for the log: ledger's mechanical and fold checks with adr's actor policy, template
 * lint against the templates in the head tree and, for older versions, the history of
 * `historyRef`, the scope-glob and anchor checks, and the decision checks over code
 * (`decision/governed-by-inactive`, `decision/scope-narrowed`). With `[log] index = "committed"`,
 * also the freshness of `<root>/index.md`.
 */
export function adrChecks(log: DecisionLog, historyRef: string | null): readonly Check[] {
  return [
    ...foldChecks(adrKind, {
      options: { acceptRequiresHuman: log.adr.acceptRequiresHuman },
      templates: gitTemplates(log.git, { historyRef }),
    }),
    scopeGlobCheck(),
    anchorCheck({ keyword: log.adr.anchorKeyword, exclude: log.adr.anchorExclude }),
    governedByInactive(log),
    scopeNarrowed(log),
    ...(log.adr.index === "committed" ? [decisionIndexCheck(log)] : []),
  ];
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
