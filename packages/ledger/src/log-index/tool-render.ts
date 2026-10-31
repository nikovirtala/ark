import { type Numbering, projectNumbering } from "../fold/numbering.js";
import type { Git } from "../git/git.js";
import { withGitOperation } from "../git/operation.js";
import { refReader, type TreeReader } from "../git/tree.js";
import { classifyPath, type LogLayout } from "../identity/layout.js";
import type { AnyKind } from "../kind/types.js";
import { type IndexSpec, readIndexNumbers, renderIndex } from "./render.js";

/** The repo-relative path of a log's generated index: `<root>/index.md`. */
export const indexPath = (layout: LogLayout): string => `${layout.root}/index.md`;

/** What `renderLogIndex` renders: a tool's log in `tree`, with the tool's projection and spec. */
export interface LogIndexInput<V> {
  readonly kind: AnyKind;
  readonly layout: LogLayout;
  /** `[log] main_branch`; `null` resolves it automatically. */
  readonly mainRef: string | null;
  readonly tree: TreeReader;
  /** The commit `tree` builds on: HEAD, a commit, or null on an unborn HEAD. */
  readonly history: string | null;
  /** The views of the subjects in `tree`, numbered with `numbering`. */
  readonly views: (tree: TreeReader, numbering: Numbering) => Promise<readonly V[]>;
  /** The index spec for `views`; built per render, so cells can refer to other views. */
  readonly spec: (root: string, views: readonly V[]) => IndexSpec<V>;
}

/**
 * The index `tree` must hold: its subjects, numbered as they will be once the commit holding
 * `tree` (which builds on `history`) is on main (design 2b D2), with `mainRef`'s numbers first. A
 * tree that isn't a commit's (the work tree, the index) also merges `MERGE_HEAD` while a merge is
 * in progress. In a shallow clone the numbers continue from those `history`'s index recorded;
 * `null` when there are none, so the numbers can't be projected.
 */
export async function renderLogIndex<V>(git: Git, o: LogIndexInput<V>): Promise<string | null> {
  return withGitOperation(async () => {
    const { layout, history, tree } = o;
    const mergeHead =
      tree.commit === null && history !== null ? await git.resolveCommit("MERGE_HEAD") : null;
    const numbering = await projectNumbering(git, {
      kind: o.kind,
      layout,
      history,
      tree,
      mainRef: o.mainRef,
      merging: mergeHead === null ? [] : [mergeHead],
      recorded: async () =>
        history === null
          ? null
          : readIndexNumbers(await refReader(git, history), indexPath(layout)),
    });
    if (!numbering.available) return null;
    const views = await o.views(tree, numbering);
    return renderIndex(o.spec(layout.root, views), views, numbering);
  });
}

/** At most this many paths are named in the unstaged-files `index/stale` message. */
const UNSTAGED_NAMED = 5;

/**
 * What the unstaged-files `index/stale` finding and the matching write note both start with:
 * `path` lists `files` (the first five of them), `noun` files such as `"decision"`'s, which aren't
 * staged.
 */
export function unstagedIndexText(path: string, files: readonly string[], noun: string): string {
  const named = files.slice(0, UNSTAGED_NAMED).join(", ");
  const more = files.length > UNSTAGED_NAMED ? ", …" : "";
  return `${path} lists ${noun} files that aren't staged (${named}${more})`;
}

/**
 * The log's event and body files whose work-tree content isn't staged (untracked or modified),
 * sorted: the cause of a staged `index.md` that only the work tree's render matches.
 */
export async function unstagedLogFiles(git: Git, layout: LogLayout): Promise<string[]> {
  const paths = [
    ...(await git.unstagedPaths([layout.root])),
    ...(await git.untrackedPaths([layout.root])),
  ];
  return [...new Set(paths)]
    .filter((p) => {
      const area = classifyPath(layout, p).area;
      return area === "event" || area === "body";
    })
    .sort();
}
