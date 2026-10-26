import { adrKind, type DecisionView } from "@nikovirtala/adr/kind";
import {
  ConfigError,
  type FoldedLogOf,
  foldLog,
  loadLog,
  type Numbering,
  numberLog,
  openToolLog,
  projectLog,
  readIndexNumbers,
  refReader,
  type ToolConfig,
} from "@nikovirtala/ledger";
import type { SourceLog } from "./kind.js";
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
    subjects: new Map(
      [...d.views].map(([id, v]) => [
        id,
        { status: v.status, display: v.display, title: v.title, effective: v.effective },
      ]),
    ),
  };
}

/**
 * The map for `IssueOptions.sources`: `adr` (the local decision log) when the repository has one,
 * and each `[[sources]]` entry unread (`subjects: null`), so references into it aren't checked.
 */
export function sourceLogsOf(
  decisions: DecisionLogRead | null,
  config: ToolConfig | null,
): ReadonlyMap<string, SourceLog> {
  const out = new Map<string, SourceLog>();
  if (decisions !== null) out.set("adr", decisionSource(decisions));
  for (const s of config?.sources ?? []) {
    out.set(s.name, { kind: s.kind === "adr" ? "adr" : "issues", local: false, subjects: null });
  }
  return out;
}

/** The other logs an issue log's references can name (design "Config", last part). */
export async function readSourceLogs(log: IssueLog): Promise<ReadonlyMap<string, SourceLog>> {
  return sourceLogsOf(await readDecisionLog(log), log.config);
}
