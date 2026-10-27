import {
  type Check,
  type FoldedLogOf,
  finding,
  projectLog,
  scanAnchors,
} from "@nikovirtala/ledger";
import { issueKind } from "./kind.js";
import { type IssueLog, numberIssues } from "./log.js";

const underRoot = (root: string, p: string) => p === root || p.startsWith(`${root}/`);

/**
 * `issue/stale-anchor` (warning): an `issue:<id>` comment anchor naming a closed issue, scanned
 * like ledger's `anchorCheck` (the changed files outside the log root for an unwidened staged
 * run, else the whole head tree; `[scope] anchor_exclude` skipped). A closed duplicate names its
 * canonical issue, which the anchor should point at.
 */
export function staleAnchorCheck(log: IssueLog): Check {
  return {
    id: "issue-stale-anchors",
    async run(ctx) {
      const repo = ctx.repo;
      const head = ctx.folded?.head as FoldedLogOf<typeof issueKind> | undefined;
      if (repo === undefined || head === undefined) return [];
      const root = ctx.layout.root;
      const paths =
        repo.mode === "staged" && ctx.scope === "changed"
          ? (await repo.git.changedPaths(repo.base, repo.head)).filter((p) => !underRoot(root, p))
          : undefined;
      if (paths !== undefined && paths.length === 0) return [];
      const anchors = (
        await scanAnchors(repo.git, {
          keyword: log.issues.anchorKeyword,
          tree: repo.head,
          ...(paths === undefined ? {} : { paths }),
          excludeDirs: [root],
          exclude: log.issues.anchorExclude,
        })
      ).filter((a) => a.source === null);
      const closed = anchors.filter((a) => head.subjects.get(a.id)?.status === "closed");
      if (closed.length === 0) return [];
      const views = projectLog(issueKind, head, { numbering: await numberIssues(log) }).views;
      const display = (id: string) => views.get(id)?.display ?? id;
      return closed.map((a) => {
        const v = views.get(a.id);
        const canonical = v?.duplicate_of ?? null;
        const what =
          canonical === null
            ? `${display(a.id)}, which is closed; remove the anchor or reopen the issue`
            : `${display(a.id)}, which is closed as a duplicate of ${display(canonical)}; anchor ${display(canonical)} instead`;
        return finding({
          severity: "warning",
          rule: "issue/stale-anchor",
          message: `anchor ${log.issues.anchorKeyword}:${a.id} names ${what}`,
          file: a.path,
          line: a.line,
          subject: a.id,
        });
      });
    },
  };
}
