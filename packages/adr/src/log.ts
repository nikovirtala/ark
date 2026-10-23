import {
  type CheckContext,
  compileKind,
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
  projectLog,
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
}

/** `numberLog` on the repository, then `readDecisionsFrom(log.tree, …)`. */
export async function readDecisions(log: DecisionLog): Promise<DecisionsRead> {
  const numbering = await numberLog(log.git, {
    kind: adrKind,
    layout: log.layout,
    mainRef: log.adr.mainBranch,
  });
  return readDecisionsFrom(log.tree, {
    layout: log.layout,
    adr: log.adr,
    numbering,
    ref: log.ref,
    commit: log.commit,
    notes: log.notes,
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
  const options = { acceptRequiresHuman: adr.acceptRequiresHuman };
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
  };
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
        `decision ${shown} is in another log; cross-log references arrive in phase 2`,
      );
    case "numbers-unavailable":
      throw new UsageError(
        `decision numbers are unavailable (${unavailableReason(read.numbering)}); use the decision's id instead of ${shown}`,
      );
    case "not-found":
      throw new UsageError(`unknown decision ${input.trim()}`);
  }
}
