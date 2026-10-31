import type { CompiledKind, KindSchema } from "../envelope/kind.js";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { type Finding, sortFindings } from "../findings/finding.js";
import { compareEvents, foldLog, sortInLogOrder } from "../fold/fold.js";
import { type Numbering, numberLog } from "../fold/numbering.js";
import { type Projection, projectLog } from "../fold/project.js";
import type { Git } from "../git/git.js";
import { withGitOperation } from "../git/operation.js";
import { refReader, type TreeReader } from "../git/tree.js";
import { parseEventFileName } from "../identity/files.js";
import { classifyPath, type LogLayout } from "../identity/layout.js";
import type { AnyKind, FoldedLogOf, ViewOf } from "../kind/types.js";
import { type LoadedEvent, type LogSnapshot, loadLog } from "../log/snapshot.js";
import { readIndexNumbers } from "../log-index/render.js";
import { type CheckContext, loadFindings } from "../verify/checks.js";
import { diffTrees } from "../verify/diff.js";
import { invariantsCheck, relateCheck, transitions } from "../verify/fold-checks.js";
import type { ToolLog } from "./tool-log.js";

const compiledKinds = new WeakMap<KindSchema, CompiledKind>();

/** `compileKind(kind)`, once per kind: tools read their log on every command. */
export function compiledKindOf(kind: KindSchema): CompiledKind {
  let c = compiledKinds.get(kind);
  if (c === undefined) {
    c = compileKind(kind);
    compiledKinds.set(kind, c);
  }
  return c;
}

/** One read of a log with its kind: what a tool's `list`, `show` and write plans start from. */
export interface KindLogRead<K extends AnyKind> {
  readonly snapshot: LogSnapshot;
  readonly folded: FoldedLogOf<K>;
  readonly projection: Projection<ViewOf<K>>;
  /** Load, transition, invariant and relate findings, with the kind's name, sorted. */
  readonly findings: readonly Finding[];
}

/**
 * Loads, folds, checks and projects the log at `layout` in `tree`. The checks are the ones a read
 * runs, with no diff: `loadFindings`, `transitions`, then `invariantsCheck` and `relateCheck` with
 * `checkOptions`; every finding gets `kind: kind.name`. `numbering` numbers the projection, and
 * `projectOptions` reaches the kind's `project` as `ctx.options` only when given.
 */
export async function readKindLog<K extends AnyKind>(
  kind: K,
  tree: TreeReader,
  o: {
    readonly layout: LogLayout;
    readonly numbering: Numbering;
    readonly checkOptions?: unknown;
    readonly projectOptions?: unknown;
  },
): Promise<KindLogRead<K>> {
  const { layout, numbering } = o;
  const compiled = compiledKindOf(kind);
  const snapshot = await loadLog(tree, { kind: compiled, layout });
  const folded = foldLog(kind, snapshot);
  const ctx: CheckContext = {
    kind: compiled,
    layout,
    base: null,
    head: snapshot,
    changes: [],
    scope: "all",
    inScope: new Set(snapshot.subjects.keys()),
    folded: { head: folded, base: null },
  };
  const findings: Finding[] = [];
  for (const check of [
    loadFindings,
    transitions,
    invariantsCheck(o.checkOptions),
    relateCheck(o.checkOptions),
  ]) {
    findings.push(...(await check.run(ctx)));
  }
  return {
    snapshot,
    folded,
    projection: projectLog(kind, folded, {
      numbering,
      ...(o.projectOptions === undefined ? {} : { options: o.projectOptions }),
    }),
    findings: sortFindings(findings.map((f) => ({ ...f, kind: kind.name }))),
  };
}

/**
 * The display numbers a tool's read uses: `numberLog` on the repository. In a shallow clone of a
 * log with `index: "committed"`, the numbers come from `<root>/index.md` in the commit being read
 * (`ref`, else HEAD, resolved when the numbers are needed), never from the work tree's copy, which
 * may number acceptances that exist only there.
 */
export async function numberToolLog(
  git: Git,
  o: {
    readonly kind: AnyKind;
    readonly layout: LogLayout;
    readonly mainRef: string | null;
    /** `[log] index`; only `"committed"` has a fallback. */
    readonly index: "none" | "committed";
    readonly ref: string | null;
  },
): Promise<Numbering> {
  return numberLog(git, {
    kind: o.kind,
    layout: o.layout,
    mainRef: o.mainRef,
    ...(o.index === "committed"
      ? {
          fallback: async () => {
            const c = await git.resolveCommit(o.ref ?? "HEAD");
            return c === null
              ? null
              : readIndexNumbers(await refReader(git, c), `${o.layout.root}/index.md`);
          },
        }
      : {}),
  });
}

/** The `since` key of `<tool> list --since <rev>` (design 2b D7). */
export interface ChangedSince {
  /** The revision as given, such as `ORIG_HEAD`. */
  readonly rev: string;
  readonly commit: string;
  /** Event files added since `rev`, in log order (`(at, id)`, then path; `sortInLogOrder`). */
  readonly events: readonly {
    readonly subject: string;
    readonly type: string;
    readonly path: string;
  }[];
}

/**
 * The event files in `--ref`'s tree (else HEAD's) that `rev`'s tree lacks (design 2b D7). Diffing
 * trees answers "what did this pull bring" for fast-forwards and merges (`ORIG_HEAD` is the tip
 * before them), and lists nothing for a rebase of your own work, whose events are in both trees.
 * Throws `RefNotFoundError` when either revision doesn't resolve.
 */
export async function changedSince(
  log: Pick<ToolLog, "git" | "layout" | "ref">,
  rev: string,
): Promise<ChangedSince> {
  return withGitOperation(async () => {
    const base = await refReader(log.git, rev);
    const head = await refReader(log.git, log.ref ?? "HEAD");
    const changes = await diffTrees(base, head, `${log.layout.root}/${log.layout.events}`);
    const events = changes.flatMap((c) => {
      if (c.status !== "added") return [];
      const p = classifyPath(log.layout, c.path);
      if (p.area !== "event" || p.subject === null || p.file.includes("/")) return [];
      const name = parseEventFileName(p.file);
      return name === null ? [] : [{ subject: p.subject, type: name.type, path: c.path }];
    });
    return { rev, commit: base.commit ?? "", events: await sortInLogOrder(head, events) };
  });
}

/**
 * Why numbers are unavailable, in words: `shallow clone`, `<source> has no committed index.md`
 * (`the log` without a source name) or `no main branch`.
 */
export function unavailableReason(n: Numbering, source: string | null = null): string {
  if (n.reason === "shallow") return "shallow clone";
  if (n.reason === "no-index") return `${source ?? "the log"} has no committed index.md`;
  return "no main branch";
}

/** The `numbering` key of the read documents. */
export interface NumberingJson {
  readonly available: boolean;
  readonly reason: "shallow" | "no-main-ref" | "no-index" | "index" | null;
  readonly ref: string | null;
}

/** The `numbering` key of a read's `list`, `show` and `for` documents. */
export const numberingJson = (read: { readonly numbering: Numbering }): NumberingJson => ({
  available: read.numbering.available,
  reason: read.numbering.reason,
  ref: read.numbering.ref,
});

/**
 * A subject's valid events in fold order (`compareEvents`, then path), for `show --history`;
 * events that didn't parse or validate are left out.
 */
export function eventsInFoldOrder(events: readonly LoadedEvent[]): EventEnvelope[] {
  return events
    .flatMap((e) => (e.event === null ? [] : [{ path: e.path, event: e.event }]))
    .sort((a, b) => compareEvents({ ...a.event, path: a.path }, { ...b.event, path: b.path }))
    .map((e) => e.event);
}
