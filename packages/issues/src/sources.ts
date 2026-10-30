import { adrKind, type DecisionView } from "@nikovirtala/adr/kind";
import {
  ConfigError,
  compileKind,
  type FetchedSource,
  type FoldedLogOf,
  foldLog,
  loadLog,
  NO_INDEX_NUMBERING,
  type Numbering,
  numberLog,
  openToolLog,
  projectLog,
  readIndexNumbers,
  readSources,
  refReader,
  type SourceStatus,
  sourceLogRef,
  type ToolConfig,
} from "@nikovirtala/ledger";
import { type ForeignSubject, issueKind, type SourceLog } from "./kind.js";
import type { IssueLog } from "./log.js";

/** The repository's own decision log, as issues reads it for `implements` links. */
export interface DecisionLogRead {
  /** adr's log root, `docs/adr` by default. */
  readonly root: string;
  /** adr's config file, or `null` when there is none. */
  readonly configPath: string | null;
  /** adr's own numbering: its main branch, and its committed index in a shallow clone. */
  readonly numbering: Numbering;
  /** Every subject id in the log, folded or not. */
  readonly ids: ReadonlySet<string>;
  /** Folded decisions only, with adr's displays. */
  readonly views: ReadonlyMap<string, DecisionView>;
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * adr's `[log] main_branch` and `[log] index`, validated with adr's own rules (adr/src/config.ts
 * `parseAdrConfig`), so issues refuses exactly the files adr refuses. Throws `ConfigError` naming
 * adr's file and key.
 */
function adrNumberingKeys(
  config: ToolConfig | null,
  file: string | null,
): { readonly mainBranch: string | null; readonly index: "none" | "committed" } {
  const where = file ?? "adr.toml";
  const fail = (message: string) => new ConfigError(`${where}: ${message}`, { file: where });
  const log = config?.raw.log;
  if (log === undefined) return { mainBranch: null, index: "none" };
  if (!isTable(log)) throw fail("log must be a table");
  const main = log.main_branch;
  if (
    main !== undefined &&
    (typeof main !== "string" || main.trim() === "" || main.startsWith("-") || main.includes("\0"))
  ) {
    throw fail("log.main_branch must be a ref name that doesn't start with -");
  }
  const index = log.index;
  if (index !== undefined && index !== "none" && index !== "committed") {
    throw fail('log.index must be "committed" or "none"');
  }
  return {
    mainBranch: typeof main === "string" ? main : null,
    index: index === "committed" ? "committed" : "none",
  };
}

/**
 * Reads the repository's own decision log from the same tree as the issue log (the `--ref`
 * commit, the index, or the work tree), with adr's numbers: adr's main branch, and in a shallow
 * clone with adr's `[log] index = "committed"` the numbers in its committed `index.md`
 * (ADR-0010). `null` when the repository has no decision log: no adr config and no subject.
 */
export async function readDecisionLog(log: IssueLog): Promise<DecisionLogRead | null> {
  const adr = await openToolLog({
    cwd: log.cwd,
    tool: "adr",
    kind: adrKind,
    ref: log.ref,
    reader: log.reader,
    gitOptions: log.git.options,
  });
  const snapshot = await loadLog(adr.tree, { kind: adr.compiled, layout: adr.layout });
  if (adr.configPath === null && snapshot.subjects.size === 0) return null;
  const keys = adrNumberingKeys(adr.config, adr.configPath);
  const numbering = await numberLog(adr.git, {
    kind: adrKind,
    layout: adr.layout,
    mainRef: keys.mainBranch,
    ...(keys.index === "committed"
      ? {
          fallback: async () => {
            const c = await adr.git.resolveCommit(adr.ref ?? "HEAD");
            return c === null
              ? null
              : readIndexNumbers(await refReader(adr.git, c), `${adr.layout.root}/index.md`);
          },
        }
      : {}),
  });
  const folded: FoldedLogOf<typeof adrKind> = foldLog(adrKind, snapshot);
  return {
    root: adr.layout.root,
    configPath: adr.configPath,
    numbering,
    ids: new Set(snapshot.subjects.keys()),
    views: projectLog(adrKind, folded, { numbering }).views,
  };
}

/** The local decision log as the `adr` source of `IssueOptions.sources`. */
export function decisionSource(d: DecisionLogRead): SourceLog {
  return {
    kind: "adr",
    local: true,
    commit: null,
    subjects: new Map(
      [...d.views].map(([id, v]) => [
        id,
        { status: v.status, display: v.display, title: v.title, effective: v.effective },
      ]),
    ),
  };
}

/** The `kind` of a `[[sources]]` entry; config load refuses any other (`SOURCE_KINDS`). */
function sourceKind(kind: string): "issues" | "adr" {
  switch (kind) {
    case "issues":
    case "adr":
      return kind;
    default:
      throw new ConfigError(`sources kind must be "issues" or "adr", not ${JSON.stringify(kind)}`);
  }
}

/**
 * The map for `IssueOptions.sources` without reading any cache: `adr` (the local decision log)
 * when the repository has one, and each `[[sources]]` entry unread (`subjects: null`), so
 * references into it aren't checked.
 */
export function sourceLogsOf(
  decisions: DecisionLogRead | null,
  config: ToolConfig | null,
): ReadonlyMap<string, SourceLog> {
  const out = new Map<string, SourceLog>();
  if (decisions !== null) out.set("adr", decisionSource(decisions));
  for (const s of config?.sources ?? []) {
    out.set(s.name, { kind: sourceKind(s.kind), local: false, subjects: null, commit: null });
  }
  return out;
}

/** What `readIssueSources` read: the logs references can name, and each source's status. */
export interface IssueSources {
  /** `IssueOptions.sources`: the local decision log and every `[[sources]]` entry. */
  readonly logs: ReadonlyMap<string, SourceLog>;
  /** What each `[[sources]]` entry resolved to; the local decision log isn't a source here. */
  readonly statuses: readonly SourceStatus[];
  /** Cached sources without a log at their root. */
  readonly notes: readonly string[];
}

const compiledIssues = compileKind(issueKind);
const compiledDecisions = compileKind(adrKind);

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

/** A cached source's subjects, folded with its kind and numbered from its committed index. */
async function foreignSubjects(
  fetched: FetchedSource,
  kind: "issues" | "adr",
): Promise<{
  readonly subjects: Map<string, ForeignSubject>;
  readonly root: string;
  readonly empty: boolean;
}> {
  const def = kind === "adr" ? adrKind.def : issueKind.def;
  const ref = sourceLogRef(fetched, { layout: def.layout, defaultRoot: def.defaultRoot });
  const numbering = indexNumbering(await readIndexNumbers(ref.tree, `${ref.layout.root}/index.md`));
  const subjects = new Map<string, ForeignSubject>();
  if (kind === "adr") {
    const snapshot = await loadLog(ref.tree, { kind: compiledDecisions, layout: ref.layout });
    const views = projectLog(adrKind, foldLog(adrKind, snapshot), { numbering }).views;
    for (const [id, v] of views) {
      subjects.set(id, {
        status: v.status,
        display: v.display,
        title: v.title,
        effective: v.effective,
      });
    }
    return { subjects, root: ref.layout.root, empty: snapshot.subjects.size === 0 };
  }
  const snapshot = await loadLog(ref.tree, { kind: compiledIssues, layout: ref.layout });
  const views = projectLog(issueKind, foldLog(issueKind, snapshot), { numbering }).views;
  for (const [id, v] of views) {
    subjects.set(id, {
      status: v.state,
      display: v.display,
      title: v.title,
      effective: v.canonical,
    });
  }
  return { subjects, root: ref.layout.root, empty: snapshot.subjects.size === 0 };
}

/**
 * The logs an issue log's references can name, with the `[[sources]]` read under ark's fetch
 * policy: from the local cache only (`fetch: "cache"`, the default; an uncached source is
 * `subjects: null` and its references aren't checked), or fetched first (`"network"`, a failed
 * fetch throws `SourceFetchError`). Each cached source is folded with its kind (`issues`, or
 * adr's from `@nikovirtala/adr/kind`) and numbered from its committed `index.md`.
 */
export async function readIssueSources(
  log: IssueLog,
  o: {
    readonly fetch?: "cache" | "network";
    /** The local decision log, when the caller read it already. */
    readonly decisions?: DecisionLogRead | null;
  } = {},
): Promise<IssueSources> {
  const decisions = o.decisions === undefined ? await readDecisionLog(log) : o.decisions;
  const logs = new Map<string, SourceLog>();
  if (decisions !== null) logs.set("adr", decisionSource(decisions));
  const notes: string[] = [];
  const reads = await readSources(log.git, log.config?.sources ?? [], {
    fetch: o.fetch ?? "cache",
  });
  for (const r of reads) {
    const kind = sourceKind(r.config.kind);
    if (r.source === null) {
      logs.set(r.config.name, { kind, local: false, subjects: null, commit: null });
      continue;
    }
    const found = await foreignSubjects(r.source, kind);
    if (found.empty) {
      notes.push(
        `source ${r.config.name} has no ${kind === "adr" ? "decision" : "issue"} log at ${found.root} in ${r.source.commit.slice(0, 12)}`,
      );
    }
    logs.set(r.config.name, {
      kind,
      local: false,
      subjects: found.subjects,
      commit: r.source.commit,
    });
  }
  return { logs, statuses: reads.map((r) => r.status), notes };
}

/** The other logs an issue log's references can name, from the cache (`readIssueSources`). */
export async function readSourceLogs(
  log: IssueLog,
  o: { readonly fetch?: "cache" | "network" } = {},
): Promise<ReadonlyMap<string, SourceLog>> {
  return (await readIssueSources(log, o)).logs;
}
