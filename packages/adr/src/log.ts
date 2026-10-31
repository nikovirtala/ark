import {
  type Finding,
  type FoldedLogOf,
  type GitOptions,
  type LogLayout,
  type Numbering,
  numberToolLog,
  openToolLog,
  type Projection,
  readKindLog,
  resolveSubjectInput,
  type ToolLog,
  type TreeReader,
  UsageError,
  unavailableReason,
  withGitOperation,
} from "@nikovirtala/ledger";
import { type AdrConfig, parseAdrConfig } from "./config.js";
import { adrKind, type DecisionView } from "./kind.js";

/** A decision log opened for the CLI or MCP: ledger's tool log plus adr's config. */
export interface DecisionLog extends ToolLog {
  readonly adr: AdrConfig;
}

/**
 * Opens the decision log (design D3): `--root`, else `adr.toml`'s `[log] root`, else `docs/adr`;
 * read from the `ref` tree, the index or the work tree.
 */
export async function openDecisionLog(o: {
  readonly cwd: string;
  readonly root?: string | null;
  readonly ref?: string | null;
  readonly reader?: "worktree" | "index";
  readonly gitOptions?: GitOptions;
}): Promise<DecisionLog> {
  const log = await openToolLog({ ...o, tool: "adr", kind: adrKind });
  return { ...log, adr: parseAdrConfig(log.config, log.configPath) };
}

/** One read of a decision log: everything list, show and the write plans need. */
export interface DecisionsRead {
  /** The tree that was read, its layout and config; no `Git`, so plans can run on a MemoryTree. */
  readonly tree: TreeReader;
  readonly layout: LogLayout;
  readonly adr: AdrConfig;
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly folded: FoldedLogOf<typeof adrKind>;
  readonly projection: Projection<DecisionView>;
  readonly numbering: Numbering;
  /** Load, transition, invariant and relate findings; no diff-based checks. */
  readonly findings: readonly Finding[];
  /** How the log was located (`ToolLog.notes`); `[]` for a MemoryTree read. */
  readonly notes: readonly string[];
  /** The `[[sources]]` names in the config; listings read them only with `--source`. */
  readonly sources: readonly string[];
  /** The `[[sources]]` entry this read is of (`--source`), or `null` for the local log. */
  readonly source: string | null;
}

/**
 * `numberLog` on the repository, then `readDecisionsFrom(log.tree, …)`. In a shallow clone of a
 * log with `[log] index = "committed"`, the numbers come from `<root>/index.md` in the commit
 * being read (`--ref`, else HEAD, resolved when the numbers are needed), never from the work tree's
 * copy, which may number acceptances that exist only there (design 2b D1, §4.6).
 */
export async function readDecisions(log: DecisionLog): Promise<DecisionsRead> {
  return withGitOperation(async () => {
    return readDecisionsFrom(log.tree, {
      layout: log.layout,
      adr: log.adr,
      numbering: await numberDecisions(log),
      ref: log.ref,
      commit: log.commit,
      notes: log.notes,
      sources: (log.config?.sources ?? []).map((s) => s.name),
    });
  });
}

/** The display numbers `readDecisions` uses, with its shallow-clone fallback to `index.md`. */
export async function numberDecisions(log: DecisionLog): Promise<Numbering> {
  return numberToolLog(log.git, {
    kind: adrKind,
    layout: log.layout,
    mainRef: log.adr.mainBranch,
    index: log.adr.index,
    ref: log.ref,
  });
}

/** The git-free core of `readDecisions`; tests pass a MemoryTree and a hand-made `Numbering`. */
export async function readDecisionsFrom(
  tree: TreeReader,
  o: {
    readonly layout: LogLayout;
    readonly adr: AdrConfig;
    readonly numbering: Numbering;
    readonly ref?: string | null;
    readonly commit?: string | null;
    readonly notes?: readonly string[];
    readonly sources?: readonly string[];
    readonly source?: string | null;
  },
): Promise<DecisionsRead> {
  const { layout, adr, numbering } = o;
  const { folded, projection, findings } = await readKindLog(adrKind, tree, {
    layout,
    numbering,
    checkOptions: { acceptRequiresHuman: adr.acceptRequiresHuman, sources: null },
  });
  return {
    tree,
    layout,
    adr,
    root: layout.root,
    ref: o.ref ?? null,
    commit: o.commit ?? null,
    folded,
    projection,
    numbering,
    findings,
    notes: o.notes ?? [],
    sources: o.sources ?? [],
    source: o.source ?? null,
  };
}

/**
 * The note listing reads add for a log with `[[sources]]`: the other logs are listed with
 * `--source`, from cached copies. `null` without sources, and for a `--source` read.
 */
export function sourcesNote(read: DecisionsRead): string | null {
  if (read.sources.length === 0 || read.source !== null) return null;
  return `the logs in [[sources]] (${read.sources.join(", ")}) are listed with --source <name>, from cached copies; run adr sources fetch to update them`;
}

/** `read.notes`, then the sources note when there is one. */
export function listingNotes(read: DecisionsRead): readonly string[] {
  const note = sourcesNote(read);
  return note === null ? read.notes : [...read.notes, note];
}

/**
 * The note a read command adds about where numbers come from: the shallow-clone index, a
 * `--source` log's committed index, or why they are unavailable (`unavailable: false` leaves that
 * one out, except for a `--source` log without a committed index; a `--source` log that isn't
 * fetched never gets it, its "not fetched" note says why); `null` for none.
 */
export function numberingNote(
  read: DecisionsRead,
  o: { readonly unavailable: boolean },
): string | null {
  const n = read.numbering;
  if (n.reason === "index") {
    return read.source === null
      ? `numbers come from ${read.root}/index.md (shallow clone)`
      : `numbers come from ${read.source}'s committed index.md`;
  }
  // Only a --source read has no-index; it says why the source shows ids even for search.
  if (n.reason === "no-index") {
    return `numbers are unavailable (${unavailableReason(n, read.source)}); decisions display by id`;
  }
  if (n.available || !o.unavailable) return null;
  // Only a --source read of a source that isn't fetched has no-main-ref.
  if (read.source !== null && n.reason === "no-main-ref") return null;
  return n.reason === "shallow"
    ? 'numbers are unavailable (shallow clone); run git fetch --unshallow, or commit an index with [log] index = "committed"'
    : `numbers are unavailable (${unavailableReason(n)}); decisions display by id`;
}

/**
 * The id a decision argument names: an id, or a number in any form `parseDecisionNumber` takes.
 * Throws `UsageError` (exit 2) naming the reason when it names nothing.
 */
export function resolveDecision(read: DecisionsRead, input: string): string {
  const r = resolveSubjectInput(input, {
    subjects: new Set(read.folded.subjects.keys()),
    kind: adrKind,
    numbering: read.numbering,
  });
  if (r.ok) return r.id;
  const shown = JSON.stringify(input.trim());
  switch (r.reason) {
    case "malformed":
      throw new UsageError(`invalid decision ${JSON.stringify(input)}`);
    case "qualified":
      throw new UsageError(
        `decision ${shown} is in another log; cross-log references aren't supported yet`,
      );
    case "numbers-unavailable":
      throw new UsageError(
        `decision numbers are unavailable (${unavailableReason(read.numbering)}); use the decision's id instead of ${shown}`,
      );
    case "not-found":
      throw new UsageError(`unknown decision ${input.trim()}`);
  }
}

/**
 * ledger's `changedSince` (the `since` key of `adr list --since <rev>`, design 2b D7) and
 * `unavailableReason`, under adr's names.
 */
export { type ChangedSince, changedSince, unavailableReason } from "@nikovirtala/ledger";
