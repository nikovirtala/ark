import {
  compileKind,
  foldLog,
  loadLog,
  MemoryTree,
  NO_INDEX_NUMBERING,
  NO_NUMBERING,
  type Numbering,
  projectLog,
  readIndexNumbers,
  readSources,
  type SourceConfig,
  type SourceStatus,
  sourceLogRef,
  sourcesOfKinds,
  UsageError,
  withGitOperation,
} from "@nikovirtala/ledger";
import { type AdrSource, adrKind, type ForeignDecision } from "./kind.js";
import { type DecisionLog, type DecisionsRead, readDecisionsFrom } from "./log.js";

export type { AdrSource, ForeignDecision };

export interface DecisionSources {
  /** Every `kind = "adr"` entry by name, for `AdrOptions.sources`. */
  readonly logs: ReadonlyMap<string, AdrSource>;
  /** What each `kind = "adr"` entry resolved to, for the report's `sources` field. */
  readonly statuses: readonly SourceStatus[];
  readonly notes: readonly string[];
}

/** The kinds adr reads from `[[sources]]`: only decision logs. */
export const DECISION_SOURCE_KINDS: readonly string[] = ["adr"];

const compiled = compileKind(adrKind);

/** Numbers recorded in a source's committed index, as a `Numbering`. */
function indexNumbering(byId: ReadonlyMap<string, number> | null): Numbering {
  if (byId === null) return NO_INDEX_NUMBERING;
  return {
    available: true,
    reason: "index",
    ref: null,
    commit: null,
    byId,
    byNumber: new Map([...byId].map(([id, n]) => [n, id])),
  };
}

/** The `[[sources]]` entries adr reads and the ones it skips, in config order. */
export function decisionSourceConfigs(log: DecisionLog): {
  readonly sources: readonly SourceConfig[];
  readonly skipped: readonly SourceConfig[];
} {
  const all = log.config?.sources ?? [];
  const sources = sourcesOfKinds(all, DECISION_SOURCE_KINDS);
  return { sources, skipped: all.filter((s) => !sources.includes(s)) };
}

/**
 * Reads the decision logs of the `kind = "adr"` `[[sources]]` entries (other kinds are never
 * fetched): from the local cache only with `fetch: "cache"` (the default), else fetched first
 * (`readSources`; a failed fetch throws `SourceFetchError`). A cached source's decisions are folded
 * with adr's kind and numbered from its committed `index.md` (the cache is a depth-1 clone, so
 * history numbering can't work), else shown by id.
 */
export async function readDecisionSources(
  log: DecisionLog,
  o: { readonly fetch?: "cache" | "network" } = {},
): Promise<DecisionSources> {
  const { sources } = decisionSourceConfigs(log);
  const reads = await readSources(log.git, sources, { fetch: o.fetch ?? "cache" });
  const logs = new Map<string, AdrSource>();
  const notes: string[] = [];
  for (const r of reads) {
    if (r.source === null) {
      logs.set(r.config.name, { subjects: null, commit: null });
      continue;
    }
    const ref = sourceLogRef(r.source, {
      layout: adrKind.def.layout,
      defaultRoot: adrKind.def.defaultRoot,
    });
    const snapshot = await loadLog(ref.tree, { kind: compiled, layout: ref.layout });
    if (snapshot.subjects.size === 0) {
      notes.push(
        `source ${r.config.name} has no decision log at ${ref.layout.root} in ${r.source.commit.slice(0, 12)}`,
      );
    }
    const numbering = indexNumbering(
      await readIndexNumbers(ref.tree, `${ref.layout.root}/index.md`),
    );
    const projected = projectLog(adrKind, foldLog(adrKind, snapshot), { numbering }).views;
    logs.set(r.config.name, {
      commit: r.source.commit,
      subjects: new Map(
        [...projected].map(([id, v]) => [
          id,
          { status: v.status, display: v.display, title: v.title },
        ]),
      ),
    });
  }
  return { logs, statuses: reads.map((r) => r.status), notes };
}

const SOURCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The cached decision log of the `[[sources]]` entry `name`, as a `DecisionsRead` for `adr list
 * --source` and `adr search --source` (cache only, never the network). An uncached source reads as
 * an empty log with the note `<name> not fetched; run adr sources fetch`. Throws `UsageError` for a
 * name that isn't configured or whose kind adr doesn't read.
 */
export async function readSourceDecisions(log: DecisionLog, name: string): Promise<DecisionsRead> {
  return withGitOperation(async () => {
    if (!SOURCE_NAME.test(name)) {
      throw new UsageError(`--source must match ${SOURCE_NAME.source}: ${name}`);
    }
    const { sources, skipped } = decisionSourceConfigs(log);
    const other = skipped.find((s) => s.name === name);
    if (other !== undefined) {
      throw new UsageError(`source ${name} has kind ${other.kind}, which adr doesn't read`);
    }
    const config = sources.find((s) => s.name === name);
    if (config === undefined) {
      const known = [...sources, ...skipped].map((s) => s.name);
      throw new UsageError(
        known.length === 0
          ? `unknown source ${name}; there are no sources`
          : `unknown source ${name}; the sources are ${known.join(", ")}`,
      );
    }
    const [r] = await readSources(log.git, [config], { fetch: "cache" });
    const base = { adr: log.adr, notes: [...log.notes], source: name };
    if (r?.source === undefined || r.source === null) {
      return readDecisionsFrom(new MemoryTree({}), {
        ...base,
        layout: adrKind.layoutAt(config.root ?? adrKind.def.defaultRoot),
        numbering: NO_NUMBERING,
        notes: [...base.notes, `${name} not fetched; run adr sources fetch`],
      });
    }
    const ref = sourceLogRef(r.source, {
      layout: adrKind.def.layout,
      defaultRoot: adrKind.def.defaultRoot,
    });
    return readDecisionsFrom(ref.tree, {
      ...base,
      layout: ref.layout,
      numbering: indexNumbering(await readIndexNumbers(ref.tree, `${ref.layout.root}/index.md`)),
      commit: r.source.commit,
    });
  });
}
