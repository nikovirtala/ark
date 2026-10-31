import {
  isSourceName,
  readSourceLog,
  readSourceSubjects,
  readSources,
  SOURCE_NAME,
  type SourceConfig,
  type SourceStatus,
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
    const found = await readSourceSubjects(r.source, adrKind, (v) => ({
      status: v.status,
      display: v.display,
      title: v.title,
      effective: v.effective,
    }));
    if (found.empty) {
      notes.push(
        `source ${r.config.name} has no decision log at ${found.root} in ${r.source.commit.slice(0, 12)}`,
      );
    }
    logs.set(r.config.name, { commit: r.source.commit, subjects: found.subjects });
  }
  return { logs, statuses: reads.map((r) => r.status), notes };
}

/**
 * The cached decision log of the `[[sources]]` entry `name`, as a `DecisionsRead` for `adr list
 * --source` and `adr search --source` (cache only, never the network). An uncached source reads as
 * an empty log with the note `<name> not fetched; run adr sources fetch`. Throws `UsageError` for a
 * name that isn't configured or whose kind adr doesn't read.
 */
export async function readSourceDecisions(log: DecisionLog, name: string): Promise<DecisionsRead> {
  return withGitOperation(async () => {
    if (!isSourceName(name)) {
      throw new UsageError(`--source must match ^${SOURCE_NAME}$: ${name}`);
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
    const r = await readSourceLog(log.git, config, {
      kind: adrKind,
      notFetched: `${name} not fetched; run adr sources fetch`,
    });
    return readDecisionsFrom(r.tree, {
      adr: log.adr,
      layout: r.layout,
      numbering: r.numbering,
      commit: r.commit,
      notes: [...log.notes, ...r.notes],
      source: name,
    });
  });
}
