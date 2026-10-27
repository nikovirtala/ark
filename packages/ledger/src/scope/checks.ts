/**
 * Verify checks and helpers over code (design 2b D9, D10): scope globs that are invalid or match
 * no tracked file, anchors naming no subject, and the helpers a kind builds its own governance
 * checks on. They read the repository through `ctx.repo` and report nothing without it, so
 * `verifySnapshots` callers and MemoryTree tests are unaffected.
 */
import { type Finding, finding } from "../findings/finding.js";
import { foldLog } from "../fold/fold.js";
import { refReader } from "../git/tree.js";
import { classifyPath } from "../identity/layout.js";
import { isKind } from "../kind/define.js";
import type { AnyKind, FoldedLogOf, FoldedSubjectOf } from "../kind/types.js";
import { loadLog } from "../log/snapshot.js";
import type { Check, CheckContext, RepoContext } from "../verify/checks.js";
import { scanAnchors } from "./anchors.js";
import { globMatcher, parseGlob } from "./glob.js";
import { type ScopeVia, scopedSubjects, scopeLookup } from "./lookup.js";
import { latestSet } from "./set.js";

interface ScopedContext {
  readonly kind: AnyKind;
  readonly scope: NonNullable<AnyKind["def"]["scope"]>;
  readonly repo: RepoContext;
  readonly folded: NonNullable<CheckContext["folded"]>;
}

/** The parts every check here needs, or `null` when the kind has no scope or they're missing. */
function scopedContext(ctx: CheckContext): ScopedContext | null {
  const kind = ctx.kind.kind;
  if (!isKind(kind) || kind.def.scope === undefined) return null;
  const folded = ctx.folded ?? null;
  if (ctx.repo === undefined || folded === null) return null;
  return { kind, scope: kind.def.scope, repo: ctx.repo, folded };
}

/** Whether `path` is the log root or under it. */
function underRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The subject's latest applied set event: its path and set; `null` when it has none. */
function latestSetEvent(
  s: FoldedSubjectOf<AnyKind>,
  type: string,
): { readonly path: string; readonly set: readonly string[] } | null {
  for (let i = s.applied.length - 1; i >= 0; i--) {
    const a = s.applied[i];
    if (a?.event.type === type) return { path: a.path, set: latestSet(s, type) ?? [] };
  }
  return null;
}

/** The changed paths outside the log root, from the base to the head. */
async function changedCode(repo: RepoContext, root: string): Promise<string[]> {
  return (await repo.git.changedPaths(repo.base, repo.head)).filter((p) => !underRoot(root, p));
}

/**
 * `scope/glob-invalid` (error) for a glob in an in-scope subject's latest applied set that doesn't
 * parse, and `scope/glob-unmatched` (error) for a valid one that matches no tracked file of the
 * head, for subjects whose status is in `scope.activeIn`. In staged mode only touched subjects
 * are examined. Findings go on the set event's path.
 */
export function scopeGlobCheck(): Check {
  return {
    id: "scope-globs",
    async run(ctx) {
      const c = scopedContext(ctx);
      if (c === null) return [];
      const out: Finding[] = [];
      let tracked: readonly string[] | null = null;
      for (const id of [...ctx.inScope].sort()) {
        const s = c.folded.head.subjects.get(id);
        const latest = s === undefined ? null : latestSetEvent(s, c.scope.event);
        if (s === undefined || latest === null) continue;
        const active = s.status !== null && c.scope.activeIn.includes(s.status);
        for (const g of latest.set) {
          const parsed = parseGlob(g);
          const at = { file: latest.path, subject: id };
          if (!parsed.ok) {
            // parseGlob's message repeats the glob: keep only its reason.
            const reason = parsed.message.slice(parsed.message.lastIndexOf('": ') + 3);
            out.push(
              finding({
                severity: "error",
                rule: "scope/glob-invalid",
                message: `scope glob ${JSON.stringify(g)} is invalid: ${reason}`,
                ...at,
              }),
            );
            continue;
          }
          if (!active) continue;
          tracked ??= await c.repo.git.trackedPaths(c.repo.head);
          if (tracked.some((p) => parsed.glob.matches(p))) continue;
          out.push(
            finding({
              severity: "error",
              rule: "scope/glob-unmatched",
              message: `scope glob ${JSON.stringify(g)} matches no tracked file`,
              ...at,
            }),
          );
        }
      }
      return out;
    },
  };
}

/** The subject ids with an events directory in the head tree. */
async function subjectIds(ctx: CheckContext): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const e of await ctx.head.tree.list(`${ctx.layout.root}/${ctx.layout.events}`)) {
    const p = classifyPath(ctx.layout, e.path);
    if (p.area === "event" && p.subject !== null) ids.add(p.subject);
  }
  return ids;
}

/**
 * `scope/anchor-missing` (error) for a local anchor `<keyword>:<id>` whose id has no events
 * directory in the log. Staged mode scans the changed files outside the log root (the whole tree
 * when the scope was widened to every subject); range and full mode the whole head tree. Qualified anchors (another log's) aren't checked, and paths matching
 * an `exclude` glob are skipped.
 */
export function anchorCheck(o: {
  readonly keyword: string;
  readonly exclude: readonly string[];
}): Check {
  return {
    id: "scope-anchors",
    async run(ctx) {
      const c = scopedContext(ctx);
      if (c === null) return [];
      const root = ctx.layout.root;
      const paths =
        c.repo.mode === "staged" && ctx.scope === "changed"
          ? await changedCode(c.repo, root)
          : undefined;
      if (paths !== undefined && paths.length === 0) return [];
      const anchors = await scanAnchors(c.repo.git, {
        keyword: o.keyword,
        tree: c.repo.head,
        ...(paths === undefined ? {} : { paths }),
        excludeDirs: [root],
        exclude: o.exclude,
      });
      const local = anchors.filter((a) => a.source === null);
      if (local.length === 0) return [];
      const ids = await subjectIds(ctx);
      return local
        .filter((a) => !ids.has(a.id))
        .map((a) =>
          finding({
            severity: "error",
            rule: "scope/anchor-missing",
            message: `anchor ${o.keyword}:${a.id} names no ${c.kind.name} in this log`,
            file: a.path,
            line: a.line,
            subject: a.id,
          }),
        );
    },
  };
}

export interface GovernedChange {
  /** The changed path, repo-relative. */
  readonly path: string;
  readonly subject: string;
  readonly status: string;
  readonly via: readonly ScopeVia[];
}

/**
 * The changed code paths (outside the log root, base to head) that a subject whose status is in
 * `statuses` governs, by glob or local anchor: one entry per (path, subject), in path order.
 * `[]` in full mode, without `ctx.repo`, or for a kind without scope.
 *
 * A changed file can be governed by any subject, not only touched ones, so this needs the whole
 * head log. `ctx.folded.head` holds it in scope `all` and for a kind with `relate`; otherwise
 * (staged verify of a kind without `relate`) the head is loaded and folded here.
 */
export async function governedChanges(
  ctx: CheckContext,
  o: {
    readonly keyword: string;
    readonly exclude: readonly string[];
    readonly statuses: readonly string[];
  },
): Promise<GovernedChange[]> {
  const c = scopedContext(ctx);
  if (c === null || c.repo.mode === "full") return [];
  const changed = await changedCode(c.repo, ctx.layout.root);
  if (changed.length === 0) return [];
  const anchors = await scanAnchors(c.repo.git, {
    keyword: o.keyword,
    tree: c.repo.head,
    paths: changed,
    excludeDirs: [ctx.layout.root],
    exclude: o.exclude,
  });
  const head: FoldedLogOf<AnyKind> =
    ctx.scope === "all" || c.kind.def.relate !== undefined
      ? c.folded.head
      : foldLog(c.kind, await loadLog(ctx.head.tree, { kind: ctx.kind, layout: ctx.layout }));
  const subjects = scopedSubjects(head).filter((s) => o.statuses.includes(s.status));
  const status = new Map(subjects.map((s) => [s.id, s.status]));
  const lookup = scopeLookup({ subjects, anchors });
  const out: GovernedChange[] = [];
  for (const path of changed) {
    for (const m of lookup(path)) {
      const st = m.source === null ? status.get(m.id) : undefined;
      if (st !== undefined) out.push({ path, subject: m.id, status: st, via: m.via });
    }
  }
  return out;
}

export interface NarrowedScope {
  readonly subject: string;
  /** The head's latest set event. */
  readonly file: string;
  /** Files tracked at base and at head that the base set covered and the head set doesn't. */
  readonly lost: readonly string[];
}

/**
 * Subjects whose status at head is in `statuses` and that gained a set event in this change,
 * whose new set stops covering files that still exist: the files tracked at the base that the
 * base set covered, that are still tracked at head, and that the head set doesn't cover. A file
 * no longer tracked at head was moved or deleted, which isn't narrowing, so renames need no
 * detection. `[]` in full mode, without a base commit, or for a kind without scope.
 */
export async function narrowedScopes(
  ctx: CheckContext,
  o: { readonly statuses: readonly string[] },
): Promise<NarrowedScope[]> {
  const c = scopedContext(ctx);
  if (c === null || c.repo.mode === "full" || c.repo.base === null) return [];
  const ids = new Set<string>();
  for (const change of ctx.changes) {
    if (change.status !== "added") continue;
    const p = classifyPath(ctx.layout, change.path);
    if (p.area !== "event" || p.subject === null || p.file.includes("/")) continue;
    const loaded = ctx.head.subjects.get(p.subject)?.events.find((e) => e.path === change.path);
    if (loaded?.event?.type !== c.scope.event) continue;
    const status = c.folded.head.subjects.get(p.subject)?.status ?? null;
    if (status !== null && o.statuses.includes(status)) ids.add(p.subject);
  }
  if (ids.size === 0) return [];
  const { git } = c.repo;
  const base = foldLog(
    c.kind,
    await loadLog(await refReader(git, c.repo.base), {
      kind: ctx.kind,
      layout: ctx.layout,
      subjects: ids,
    }),
  );
  const atBase = await git.trackedPaths({ commit: c.repo.base });
  const atHead = new Set(await git.trackedPaths(c.repo.head));
  const out: NarrowedScope[] = [];
  for (const id of [...ids].sort()) {
    const head = c.folded.head.subjects.get(id);
    const latest = head === undefined ? null : latestSetEvent(head, c.scope.event);
    const before = base.subjects.get(id);
    if (latest === null || before === undefined) continue;
    const covered = globMatcher(latestSet(before, c.scope.event) ?? []);
    const covers = globMatcher(latest.set);
    const lost = atBase.filter(
      (p) => atHead.has(p) && covered(p).length > 0 && covers(p).length === 0,
    );
    if (lost.length > 0) out.push({ subject: id, file: latest.path, lost });
  }
  return out;
}
