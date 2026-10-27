import {
  type CheckContext,
  classifyPath,
  compileKind,
  diffTrees,
  type Finding,
  type FoldedLogOf,
  foldLog,
  type GitOptions,
  invariantsCheck,
  type LogLayout,
  loadFindings,
  loadLog,
  type Numbering,
  numberLog,
  openToolLog,
  type Projection,
  parseEventFileName,
  projectLog,
  readIndexNumbers,
  refReader,
  relateCheck,
  resolveSubjectInput,
  sortFindings,
  type ToolLog,
  type TreeReader,
  transitions,
  UsageError,
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
  return readDecisionsFrom(log.tree, {
    layout: log.layout,
    adr: log.adr,
    numbering: await numberDecisions(log),
    ref: log.ref,
    commit: log.commit,
    notes: log.notes,
    sources: (log.config?.sources ?? []).map((s) => s.name),
  });
}

/** The display numbers `readDecisions` uses, with its shallow-clone fallback to `index.md`. */
export async function numberDecisions(log: DecisionLog): Promise<Numbering> {
  return numberLog(log.git, {
    kind: adrKind,
    layout: log.layout,
    mainRef: log.adr.mainBranch,
    ...(log.adr.index === "committed"
      ? {
          fallback: async () => {
            const c = await log.git.resolveCommit(log.ref ?? "HEAD");
            return c === null
              ? null
              : readIndexNumbers(await refReader(log.git, c), `${log.layout.root}/index.md`);
          },
        }
      : {}),
  });
}

const compiled = compileKind(adrKind);

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
  const snapshot = await loadLog(tree, { kind: compiled, layout });
  const folded = foldLog(adrKind, snapshot);
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
  const options = { acceptRequiresHuman: adr.acceptRequiresHuman, sources: null };
  const findings: Finding[] = [];
  for (const check of [loadFindings, transitions, invariantsCheck(options), relateCheck(options)]) {
    findings.push(...(await check.run(ctx)));
  }
  return {
    tree,
    layout,
    adr,
    root: layout.root,
    ref: o.ref ?? null,
    commit: o.commit ?? null,
    folded,
    projection: projectLog(adrKind, folded, { numbering }),
    numbering,
    findings: sortFindings(findings.map((f) => ({ ...f, kind: adrKind.name }))),
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
 * The note a read command adds about where numbers come from: the shallow-clone index, or why
 * they are unavailable (`unavailable: false` leaves that one out); `null` for none.
 */
export function numberingNote(
  read: DecisionsRead,
  o: { readonly unavailable: boolean },
): string | null {
  const n = read.numbering;
  if (n.reason === "index") return `numbers come from ${read.root}/index.md (shallow clone)`;
  if (n.available || !o.unavailable) return null;
  return n.reason === "shallow"
    ? 'numbers are unavailable (shallow clone); run git fetch --unshallow, or commit an index with [log] index = "committed"'
    : `numbers are unavailable (${unavailableReason(n)}); decisions display by id`;
}

/** Why numbers are unavailable, in words: `shallow clone` or `no main branch`. */
export function unavailableReason(n: Numbering): string {
  return n.reason === "shallow" ? "shallow clone" : "no main branch";
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

/** The `since` key of `adr list --since <rev>` (design 2b D7). */
export interface ChangedSince {
  /** The revision as given, such as `ORIG_HEAD`. */
  readonly rev: string;
  readonly commit: string;
  /** Event files added since `rev`, sorted by path. */
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
export async function changedSince(log: DecisionLog, rev: string): Promise<ChangedSince> {
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
  events.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { rev, commit: base.commit ?? "", events };
}
