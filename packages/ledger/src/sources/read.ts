import { SourceFetchError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import type { SourceStatus } from "../findings/format.js";
import type { Git } from "../git/git.js";
import type { SourceConfig } from "./config.js";
import { type FetchedSource, fetchSource } from "./fetch.js";

export type { SourceStatus };

export interface SourceRead {
  readonly config: SourceConfig;
  readonly status: SourceStatus;
  /** The cached tree; `null` when not cached (cache mode only). */
  readonly source: FetchedSource | null;
}

/** The entries of `configs` whose `kind` is one of `kinds`, in config order. */
export function sourcesOfKinds(
  configs: readonly SourceConfig[],
  kinds: readonly string[],
): SourceConfig[] {
  return configs.filter((c) => kinds.includes(c.kind));
}

/**
 * The sources in `configs`, in config order, under ark's fetch policy. `"cache"` reads each
 * source's local cache only (no network): a source without a pin gives `source: null`, never an
 * error. `"network"` fetches each one, one at a time; a fetch that fails throws
 * `SourceFetchError`, also when an older pin exists, because the checks would otherwise run
 * against a commit nobody asked for. A full-sha ref already pinned isn't fetched again (it can't
 * change), so its `fetched` is `false`.
 */
export async function readSources(
  git: Git,
  configs: readonly SourceConfig[],
  o: { readonly fetch: "cache" | "network"; readonly timeoutMs?: number },
): Promise<SourceRead[]> {
  const out: SourceRead[] = [];
  const timeout = o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs };
  for (const config of configs) {
    const base = { name: config.name, kind: config.kind, ref: config.ref };
    if (o.fetch === "cache") {
      const source = await fetchSource(git, config, { offline: true, ...timeout }).catch(
        (e: unknown) => {
          if (e instanceof SourceFetchError) return null;
          throw e;
        },
      );
      out.push({
        config,
        status: { ...base, commit: source?.commit ?? null, fetched: false },
        source,
      });
      continue;
    }
    const before = await fetchSource(git, config, { offline: true, ...timeout }).catch(() => null);
    const source = await fetchSource(git, config, timeout);
    if (source.stale) {
      throw new SourceFetchError(
        config.name,
        `cannot fetch source ${config.name} (${config.ref}): ${source.staleReason ?? "fetch failed"}; the cache still pins ${source.commit.slice(0, 12)}`,
      );
    }
    // A pinned full sha is served from the cache without a fetch.
    const fetched = !(before !== null && before.commit === config.ref);
    out.push({ config, status: { ...base, commit: source.commit, fetched }, source });
  }
  return out;
}

/**
 * One `sources/not-fetched` warning per uncached source that `referenced` names, on `file` (the
 * config path), with no subject: references into it weren't checked.
 */
export function sourceFindings(
  statuses: readonly SourceStatus[],
  o: {
    readonly tool: string;
    readonly file: string | null;
    readonly referenced: ReadonlySet<string>;
  },
): Finding[] {
  return statuses
    .filter((s) => s.commit === null && o.referenced.has(s.name))
    .map((s) =>
      finding({
        severity: "warning",
        rule: "sources/not-fetched",
        message: `${s.name} not fetched; references not checked. Run ${o.tool} sources fetch, or verify with --fetch-sources`,
        file: o.file,
      }),
    );
}
