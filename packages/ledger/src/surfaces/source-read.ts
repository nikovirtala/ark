import { foldLog } from "../fold/fold.js";
import { NO_NUMBERING, type Numbering } from "../fold/numbering.js";
import { projectLog } from "../fold/project.js";
import type { Git } from "../git/git.js";
import { MemoryTree, type TreeReader } from "../git/tree.js";
import type { LogLayout } from "../identity/layout.js";
import type { AnyKind, ViewOf } from "../kind/types.js";
import { loadLog } from "../log/snapshot.js";
import { indexNumbering, readIndexNumbers } from "../log-index/render.js";
import type { SourceConfig } from "../sources/config.js";
import type { FetchedSource } from "../sources/fetch.js";
import type { ForeignSubject } from "../sources/foreign-subject.js";
import { readSources } from "../sources/read.js";
import { type LogRef, sourceLogRef } from "../sources/resolve.js";
import { compiledKindOf } from "./log-read.js";

/** A `[[sources]]` entry's log as `<tool> list --source` reads it. */
export interface SourceLogRead {
  readonly tree: TreeReader;
  readonly layout: LogLayout;
  readonly numbering: Numbering;
  /** The cached commit; `null` when the source isn't cached. */
  readonly commit: string | null;
  /** `[notFetched]` when the source isn't cached, else none; the tool adds its own. */
  readonly notes: string[];
}

/** A cached source's log at its root, numbered from its committed `index.md`. */
async function cachedLog(
  fetched: FetchedSource,
  kind: AnyKind,
): Promise<{ readonly ref: LogRef; readonly numbering: Numbering }> {
  const ref = sourceLogRef(fetched, { layout: kind.def.layout, defaultRoot: kind.def.defaultRoot });
  const numbering = indexNumbering(await readIndexNumbers(ref.tree, `${ref.layout.root}/index.md`));
  return { ref, numbering };
}

/**
 * The log of the `[[sources]]` entry `config` from the local cache (never the network), for a
 * tool's `--source` read once it has found and checked the entry. A cached source gives its
 * pinned tree, its layout at `root` (else the kind's default) and the numbers of its committed
 * `index.md` (the cache is a depth-1 clone, so history numbering can't work). An uncached one
 * reads as an empty tree with the layout at `config.root ?? kind.def.defaultRoot`, `NO_NUMBERING`,
 * no commit and the note `notFetched`, such as `<name> not fetched; run adr sources fetch`.
 */
export async function readSourceLog(
  git: Git,
  config: SourceConfig,
  o: { readonly kind: AnyKind; readonly notFetched: string },
): Promise<SourceLogRead> {
  const { kind } = o;
  const [r] = await readSources(git, [config], { fetch: "cache" });
  if (r?.source === undefined || r.source === null) {
    return {
      tree: new MemoryTree({}),
      layout: kind.layoutAt(config.root ?? kind.def.defaultRoot),
      numbering: NO_NUMBERING,
      commit: null,
      notes: [o.notFetched],
    };
  }
  const { ref, numbering } = await cachedLog(r.source, kind);
  return { tree: ref.tree, layout: ref.layout, numbering, commit: r.source.commit, notes: [] };
}

/** A cached source's subjects, as `readSourceSubjects` folds them. */
export interface SourceSubjects<S extends string = string> {
  readonly subjects: Map<string, ForeignSubject<S>>;
  /** The log root read inside the source. */
  readonly root: string;
  /** No subject at `root`, for the tool's `has no … log at` note. */
  readonly empty: boolean;
}

/**
 * A cached source's subjects, folded with `kind`, numbered from its committed `index.md` and
 * mapped to `ForeignSubject`s by `toForeign`, by id.
 */
export async function readSourceSubjects<K extends AnyKind, S extends string = string>(
  fetched: FetchedSource,
  kind: K,
  toForeign: (view: ViewOf<K>) => ForeignSubject<S>,
): Promise<SourceSubjects<S>> {
  const { ref, numbering } = await cachedLog(fetched, kind);
  const snapshot = await loadLog(ref.tree, { kind: compiledKindOf(kind), layout: ref.layout });
  const views = projectLog(kind, foldLog(kind, snapshot), { numbering }).views;
  const subjects = new Map<string, ForeignSubject<S>>();
  for (const [id, v] of views) subjects.set(id, toForeign(v));
  return { subjects, root: ref.layout.root, empty: snapshot.subjects.size === 0 };
}
