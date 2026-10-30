import { RefNotFoundError } from "../errors.js";
import { type Git, operationMemo } from "../git/git.js";
import { firstParentAdditions } from "../git/history.js";
import { withGitOperation } from "../git/operation.js";
import type { TreeReader } from "../git/tree.js";
import { parseEventFileName } from "../identity/files.js";
import { classifyPath, type LogLayout } from "../identity/layout.js";
import type { AnyKind } from "../kind/types.js";

/** Display numbers of a log's subjects, assigned on the main ref (design D7). */
export interface Numbering {
  readonly available: boolean;
  /**
   * `"index"`: numbers read from a recorded index rather than history (a shallow clone's, or
   * another repository's). `"no-index"`: a log read only from a tree, such as another
   * repository's cached log, that has no recorded index to read them from.
   */
  readonly reason: "shallow" | "no-main-ref" | "no-index" | "index" | null;
  /** The ref used: a full ref name such as `refs/remotes/origin/main`, or a configured ref as given. */
  readonly ref: string | null;
  readonly commit: string | null;
  readonly byId: ReadonlyMap<string, number>;
  readonly byNumber: ReadonlyMap<number, string>;
}

/** No numbers: `available: false`, `reason: "no-main-ref"`, empty maps. */
export const NO_NUMBERING: Numbering = Object.freeze({
  available: false,
  reason: "no-main-ref",
  ref: null,
  commit: null,
  byId: new Map<string, number>(),
  byNumber: new Map<number, string>(),
});

/** No numbers because a log read from a tree has no recorded index: `reason: "no-index"`. */
export const NO_INDEX_NUMBERING: Numbering = Object.freeze({
  ...NO_NUMBERING,
  reason: "no-index",
});

const MAIN_CANDIDATES = [
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
] as const;

/**
 * The ref whose first-parent history assigns numbers. A configured ref is used as given and must
 * resolve (else `RefNotFoundError`). Otherwise the first that resolves of `origin/HEAD`'s target,
 * `origin/main`, `origin/master`, `main` and `master`, so the shared main wins over a local one;
 * `null` when none does.
 */
export async function resolveMainRef(git: Git, configured?: string | null): Promise<string | null> {
  if (configured !== undefined && configured !== null) {
    if ((await git.resolveCommit(configured)) === null) throw new RefNotFoundError(configured);
    return configured;
  }
  const originHead = await git.symbolicRef("refs/remotes/origin/HEAD");
  for (const ref of [...(originHead === null ? [] : [originHead]), ...MAIN_CANDIDATES]) {
    if ((await git.resolveCommit(ref)) !== null) return ref;
  }
  return null;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The order of one commit's `on` files: stamp, then rand, then subject. assignNumbers sorts with
 * it.
 */
export function compareNumberingKeys(
  a: { readonly stamp: string; readonly rand: string; readonly subject: string },
  b: { readonly stamp: string; readonly rand: string; readonly subject: string },
): number {
  return cmp(a.stamp, b.stamp) || cmp(a.rand, b.rand) || cmp(a.subject, b.subject);
}

/** The commit key of the files `projectNumbering` numbers last; no commit sha can equal it. */
export const PENDING_COMMIT = "\0pending";

interface NumberingKey {
  readonly subject: string;
  readonly stamp: string;
  readonly rand: string;
}

/** The key of an `on` event file directly in a valid subject directory; `null` for other paths. */
function numberingKey(
  path: string,
  o: { readonly layout: LogLayout; readonly on: string },
): NumberingKey | null {
  const c = classifyPath(o.layout, path);
  if (c.area !== "event" || c.subject === null || c.file.includes("/")) return null;
  const name = parseEventFileName(c.file);
  if (name === null || name.type !== o.on) return null;
  return { subject: c.subject, stamp: name.stamp, rand: name.rand };
}

const byNumberOf = (byId: ReadonlyMap<string, number>) =>
  new Map([...byId].map(([id, n]) => [n, id]));

/**
 * Pure: D7's rule over `firstParentAdditions` output. Additions are grouped by `commit` in input
 * order (first-parent order, oldest first); within a commit, qualifying paths are sorted by
 * `(stamp, rand, subject)` parsed from the path, never by the input path order. A qualifying path
 * is an `on` event file directly in a valid subject directory; each subject is numbered once, at
 * its first one, so later files never renumber anything.
 */
export function assignNumbers(
  additions: readonly { readonly path: string; readonly commit: string }[],
  o: { readonly layout: LogLayout; readonly on: string },
): Map<string, number> {
  const commits = new Map<string, NumberingKey[]>();
  for (const { path, commit } of additions) {
    const key = numberingKey(path, o);
    if (key === null) continue;
    let group = commits.get(commit);
    if (group === undefined) {
      group = [];
      commits.set(commit, group);
    }
    group.push(key);
  }
  const numbers = new Map<string, number>();
  for (const group of commits.values()) {
    group.sort(compareNumberingKeys);
    for (const { subject } of group) {
      if (!numbers.has(subject)) numbers.set(subject, numbers.size + 1);
    }
  }
  return numbers;
}

/**
 * Numbers a log's subjects from the main ref's first-parent history (`mainRef`: a configured ref;
 * `undefined` or `null` resolves it automatically). Unavailable for a kind without `numbering` and
 * without a main ref. In a shallow repository the history is incomplete, so the numbers are the
 * ones `fallback` returns (`reason: "index"`), or unavailable (`reason: "shallow"`) without them.
 */
export async function numberLog(
  git: Git,
  o: {
    readonly kind: AnyKind;
    readonly layout: LogLayout;
    readonly mainRef?: string | null;
    /** Shallow clones only: numbers recorded elsewhere (an index), or null when there are none. */
    readonly fallback?: () => Promise<ReadonlyMap<string, number> | null>;
  },
): Promise<Numbering> {
  return withGitOperation(async () => {
    const numbering = o.kind.def.numbering;
    if (numbering === undefined) return NO_NUMBERING;
    if (await git.isShallow()) {
      const recorded = (await o.fallback?.()) ?? null;
      if (recorded === null) return { ...NO_NUMBERING, reason: "shallow" };
      const byId = new Map(recorded);
      return {
        available: true,
        reason: "index",
        ref: null,
        commit: null,
        byId,
        byNumber: byNumberOf(byId),
      };
    }
    const ref = await resolveMainRef(git, o.mainRef);
    if (ref === null) return NO_NUMBERING;
    const commit = await git.resolveCommit(ref);
    if (commit === null) throw new RefNotFoundError(ref);
    const additions = await firstParentAdditions(
      git,
      commit,
      `${o.layout.root}/${o.layout.events}`,
    );
    const byId = assignNumbers(additions, { layout: o.layout, on: numbering.on });
    return { available: true, reason: null, ref, commit, byId, byNumber: byNumberOf(byId) };
  });
}

/**
 * The newest commit on `main`'s first-parent line that the commit being made contains (it builds
 * on `history` and merges `merging`); `null` when it contains none.
 */
async function mainBase(
  git: Git,
  main: string,
  history: string,
  merging: readonly string[],
): Promise<string | null> {
  const key = `main-base\0${main}\0${[history, ...merging].join("\0")}`;
  return operationMemo(git, key, async () => {
    const r = await git.run([
      "rev-list",
      "--first-parent",
      "--parents",
      "--end-of-options",
      main,
      ...[history, ...merging].map((c) => `^${c}`),
    ]);
    const lines = Buffer.from(r.stdout).toString("utf8").trim().split("\n").filter(Boolean);
    const last = lines.at(-1);
    if (last === undefined) return main;
    return last.split(" ")[1] ?? null;
  });
}

/**
 * The additions `projectNumbering` numbers before the pending group: main's first-parent
 * additions up to `mainBase`, then those of `history`'s own first-parent commits after it. So a
 * branch that merged main numbers main's acceptances first, as main does. When that commit is on
 * `history`'s first-parent line (main itself, a rebased branch), or there is no main ref, this
 * numbers like `history`'s first-parent additions alone.
 */
async function projectedAdditions(
  git: Git,
  o: {
    readonly history: string;
    readonly merging: readonly string[];
    readonly events: string;
    readonly mainRef: string | null | undefined;
  },
): Promise<{ path: string; commit: string }[]> {
  const own = () => firstParentAdditions(git, o.history, o.events);
  let ref: string | null;
  try {
    ref = await resolveMainRef(git, o.mainRef);
  } catch (err) {
    // A configured ref that doesn't resolve projects as if there were no main ref.
    if (err instanceof RefNotFoundError) return own();
    throw err;
  }
  const main = ref === null ? null : await git.resolveCommit(ref);
  if (main === null) return own();
  const base = await mainBase(git, main, o.history, o.merging);
  if (base === null || base === o.history) return own();
  return [
    ...(await firstParentAdditions(git, base, o.events)),
    ...(await firstParentAdditions(git, o.history, o.events, { not: [base] })),
  ];
}

/**
 * The numbers a log's subjects will have once the commit holding `tree` is on main (design D2):
 * main's first-parent additions up to the newest commit on its first-parent line that the commit
 * contains, then those of `history`'s own first-parent commits after it, then, as one last group
 * sorted like any commit's, the event files in `tree` that neither numbers yet. After a
 * fast-forward, rebase or merge-commit merge of an up-to-date branch, whether it was updated by
 * a rebase or by merging main, main's `numberLog` equals the branch's projection. Without a main
 * ref, or on main's own first-parent line, the history part is `history`'s first-parent additions.
 * Unavailable for a kind without `numbering`. In a shallow repository the history comes from
 * `recorded` instead (`reason: "index"`), with the pending subjects numbered after its highest
 * number; without it the numbers are unavailable (`reason: "shallow"`).
 */
export async function projectNumbering(
  git: Git,
  o: {
    readonly kind: AnyKind;
    readonly layout: LogLayout;
    /**
     * The commit `tree` builds on: HEAD for the work tree and the index, the commit itself for a
     * ref; null on an unborn HEAD.
     */
    readonly history: string | null;
    readonly tree: TreeReader;
    /** Shallow clones only: the numbers recorded at `history` (its index), or null. */
    readonly recorded?: () => Promise<ReadonlyMap<string, number> | null>;
    /** As `numberLog`'s: a configured main ref; `undefined` or `null` resolves it automatically. */
    readonly mainRef?: string | null;
    /** The commit's other parents: `MERGE_HEAD` while a merge is in progress. */
    readonly merging?: readonly string[];
  },
): Promise<Numbering> {
  return withGitOperation(async () => {
    const numbering = o.kind.def.numbering;
    if (numbering === undefined) return NO_NUMBERING;
    const events = `${o.layout.root}/${o.layout.events}`;
    const rule = { layout: o.layout, on: numbering.on };
    const shallow = await git.isShallow();
    const recorded = shallow ? ((await o.recorded?.()) ?? null) : null;
    if (shallow && recorded === null) return { ...NO_NUMBERING, reason: "shallow" };
    const pending = (await o.tree.list(events)).map((e) => e.path);
    if (recorded !== null) {
      // assignNumbers can't continue from recorded numbers, so the pending group is numbered here,
      // in the same order.
      const byId = new Map(recorded);
      let next = [...byId.values()].reduce((max, n) => Math.max(max, n), 0);
      const keys = pending.flatMap((path) => numberingKey(path, rule) ?? []);
      for (const { subject } of keys.sort(compareNumberingKeys)) {
        if (!byId.has(subject)) byId.set(subject, ++next);
      }
      return {
        available: true,
        reason: "index",
        ref: null,
        commit: o.history,
        byId,
        byNumber: byNumberOf(byId),
      };
    }
    const additions =
      o.history === null
        ? []
        : await projectedAdditions(git, {
            history: o.history,
            merging: o.merging ?? [],
            events,
            mainRef: o.mainRef,
          });
    const byId = assignNumbers(
      [...additions, ...pending.map((path) => ({ path, commit: PENDING_COMMIT }))],
      rule,
    );
    return {
      available: true,
      reason: null,
      ref: null,
      commit: o.history,
      byId,
      byNumber: byNumberOf(byId),
    };
  });
}
