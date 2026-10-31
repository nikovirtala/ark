import {
  type AfterStage,
  type AppliedPlan,
  type ComposeInput,
  type IndexRender,
  applyPlan as ledgerApplyPlan,
  type RenderedCommit,
  UsageError,
} from "@nikovirtala/ledger";
import type { IssueLog } from "./log.js";
import type { WritePlan } from "./plan.js";

export {
  type AfterStage,
  type AppliedPlan,
  type ComposeInput,
  type IndexRender,
  WRITE_RERUN,
} from "@nikovirtala/ledger";

type Git = IssueLog["git"];

/** The `Issue`/`Issue-Event` trailer keys. */
const TRAILER_KEYS = { subject: "Issue", event: "Issue-Event" } as const;

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * The paths a `--commit` of `plan` takes: `plan.commitScope`, widened by every issue reachable
 * from `plan.subject` whose `opened` event isn't in `HEAD` (planned, staged as added or
 * untracked) with its events directory, description and template, as adr's commit scope takes
 * every involved subject's. References are followed from each issue whose events directory is in
 * the scope, since all its staged events join the commit. A committed issue adds nothing, so an
 * unstaged edit of its description never blocks or joins. An uncommitted issue without a
 * description is a `UsageError`: its `opened` event would leave `body/missing` at the commit.
 */
async function commitScopeOf(
  git: Git,
  plan: WritePlan,
): Promise<{ scope: string[]; eventDirs: string[] }> {
  const stage = new Set(plan.stage);
  const opened = sorted(
    Object.values(plan.reach).flatMap((r) => (r.opened === null ? [] : [r.opened])),
  );
  const fresh = new Set([
    ...opened.filter((p) => stage.has(p)),
    ...(await git.stagedPaths(opened, { addedOnly: true })),
    ...(await git.untrackedPaths(opened)),
  ]);
  const paths = new Set(plan.commitScope);
  const dirs = new Set(plan.eventDirs);
  const seen = new Set<string>();
  const queue = [plan.subject];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const r = Object.hasOwn(plan.reach, id) ? plan.reach[id] : undefined;
    if (r === undefined || seen.has(id)) continue;
    seen.add(id);
    if (r.opened !== null && fresh.has(r.opened)) {
      if (r.bodies.length === 0) {
        throw new UsageError(`${r.opened} has no description; restore it, or run without --commit`);
      }
      dirs.add(r.dir);
      for (const b of r.bodies) paths.add(b);
      if (r.template !== null) paths.add(r.template);
    }
    if (dirs.has(r.dir)) queue.push(...r.refs);
  }
  return { scope: sorted([...paths, ...dirs]), eventDirs: sorted(dirs) };
}

/**
 * Applies a plan with ledger's `applyPlan` and issues' bindings: the `Issue`/`Issue-Event`
 * trailers, the commit scope `commitScopeOf` widens with the files of reached issues not yet in
 * `HEAD`, and after the editor step an index rendered again every time, from the work-tree bytes
 * of every `only` path (an edited `# ` heading changes the title).
 */
export function applyPlan(
  log: IssueLog,
  plan: WritePlan,
  o: {
    readonly commit: boolean;
    /** The commit message, without trailers; this or `compose` is required when committing. */
    readonly message?: string;
    /** Chooses the commit message once the extra staged events are known (?6). */
    readonly compose?: (c: ComposeInput) => RenderedCommit | Promise<RenderedCommit>;
    /** `message` is the user's own: append the trailers to its own trailer block, if it ends in one. */
    readonly mergeTrailers?: boolean;
    /**
     * Runs after staging (the editor step of `new`), with the scope a commit takes, so its
     * late-change check covers the reached issues' files too.
     */
    readonly afterStage?: (scope: readonly string[]) => Promise<AfterStage>;
    /** Renders the log's index; given only when the log keeps a committed index. */
    readonly index?: IndexRender;
  },
): Promise<AppliedPlan> {
  return ledgerApplyPlan(log, plan, {
    ...o,
    trailerKeys: TRAILER_KEYS,
    tool: "issues",
    noun: "issue",
    plural: "issues",
    scope: (p) => commitScopeOf(log.git, p),
    rerenderAfterEdit: "always",
    afterEditBytes: "worktree",
  });
}
