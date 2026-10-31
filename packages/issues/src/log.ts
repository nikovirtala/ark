import { parseDecisionNumber } from "@nikovirtala/adr/kind";
import {
  type Finding,
  type FoldedLogOf,
  type GitOptions,
  isSourceName,
  isSubjectId,
  type LogLayout,
  type Numbering,
  numberToolLog,
  openToolLog,
  type Projection,
  readKindLog,
  readSourceLog,
  resolveSubjectInput,
  SOURCE_NAME,
  type ToolLog,
  type TreeReader,
  UsageError,
  unavailableReason,
  withGitOperation,
} from "@nikovirtala/ledger";
import { type IssuesConfig, parseIssuesConfig } from "./config.js";
import {
  type IssueOptions,
  type IssueView,
  issueKind,
  type ProjectOptions,
  type Rel,
  type SourceLog,
} from "./kind.js";
import { type DecisionLogRead, readDecisionLog, readIssueSources } from "./sources.js";

/** An issue log opened for the CLI or MCP: ledger's tool log plus issues' config. */
export interface IssueLog extends ToolLog {
  readonly issues: IssuesConfig;
  /** The directory the log was opened from, for opening the decision log the same way. */
  readonly cwd: string;
  /** The reader the log was opened with; ignored with `ref`. */
  readonly reader: "worktree" | "index";
}

/**
 * Opens the issue log (00 Shared conventions): `--root`, else `issues.toml`'s `[log] root`, else
 * `docs/issues`; read from the `ref` tree, the index or the work tree.
 */
export async function openIssueLog(o: {
  readonly cwd: string;
  readonly root?: string | null;
  readonly ref?: string | null;
  readonly reader?: "worktree" | "index";
  readonly gitOptions?: GitOptions;
}): Promise<IssueLog> {
  const log = await openToolLog({ ...o, tool: "issues", kind: issueKind });
  return {
    ...log,
    issues: parseIssuesConfig(log.config, log.configPath),
    cwd: o.cwd,
    reader: o.reader ?? "worktree",
  };
}

/** One read of an issue log: everything list, show and the write plans need. */
export interface IssuesRead {
  /** The tree that was read, its layout and config; no `Git`, so plans can run on a MemoryTree. */
  readonly tree: TreeReader;
  readonly layout: LogLayout;
  readonly issues: IssuesConfig;
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly folded: FoldedLogOf<typeof issueKind>;
  readonly projection: Projection<IssueView>;
  readonly numbering: Numbering;
  /** The kind's options: the policy, the exclusive prefixes and the sources read. */
  readonly options: IssueOptions;
  /** The repository's own decision log, or `null` when there is none (or it wasn't read). */
  readonly decisions: DecisionLogRead | null;
  /** The `[[sources]]` names in the config; their logs are read from the local cache. */
  readonly sources: readonly string[];
  /** The `[[sources]]` entry this read is of (`list --source`), or `null` for the local log. */
  readonly source: string | null;
  /** Load, transition, invariant and relate findings; no diff-based checks. */
  readonly findings: readonly Finding[];
  /** How the log was located (`ToolLog.notes`); `[]` for a MemoryTree read. */
  readonly notes: readonly string[];
}

/**
 * `numberLog`, the decision log and the cached `[[sources]]` on the repository (never the
 * network), then `readIssuesFrom(log.tree, …)`.
 */
export async function readIssues(log: IssueLog): Promise<IssuesRead> {
  return withGitOperation(async () => {
    const decisions = await readDecisionLog(log);
    const sources = await readIssueSources(log, { decisions });
    return readIssuesFrom(log.tree, {
      layout: log.layout,
      issues: log.issues,
      numbering: await numberIssues(log),
      sources: sources.logs,
      decisions,
      ref: log.ref,
      commit: log.commit,
      notes: log.notes,
      configured: (log.config?.sources ?? []).map((s) => s.name),
    });
  });
}

/**
 * The display numbers `readIssues` uses. In a shallow clone of a log with `[log] index =
 * "committed"`, they come from `<root>/index.md` in the commit being read (`--ref`, else HEAD),
 * as adr's do (ADR-0010).
 */
export async function numberIssues(log: IssueLog): Promise<Numbering> {
  return numberToolLog(log.git, {
    kind: issueKind,
    layout: log.layout,
    mainRef: log.issues.mainBranch,
    index: log.issues.index,
    ref: log.ref,
  });
}

/** The git-free core of `readIssues`; tests pass a MemoryTree and a hand-made `Numbering`. */
export async function readIssuesFrom(
  tree: TreeReader,
  o: {
    readonly layout: LogLayout;
    readonly issues: IssuesConfig;
    readonly numbering: Numbering;
    /** `null`: qualified references aren't checked. */
    readonly sources: ReadonlyMap<string, SourceLog> | null;
    readonly decisions?: DecisionLogRead | null;
    readonly ref?: string | null;
    readonly commit?: string | null;
    readonly notes?: readonly string[];
    /** The `[[sources]]` names, for the sources note. */
    readonly configured?: readonly string[];
    /** The `[[sources]]` entry `tree` is of; default `null`, the local log. */
    readonly source?: string | null;
  },
): Promise<IssuesRead> {
  const { layout, issues, numbering } = o;
  const options: IssueOptions = {
    closeRequiresHuman: issues.closeRequiresHuman,
    mcpCanClose: issues.mcpCanClose,
    exclusive: issues.exclusive,
    sources: o.sources,
  };
  // Foreign blockers need the sources; without them (the index) the projection reads the tree only.
  const { folded, projection, findings } = await readKindLog(issueKind, tree, {
    layout,
    numbering,
    checkOptions: options,
    ...(o.sources === null
      ? {}
      : { projectOptions: { sources: o.sources } satisfies ProjectOptions }),
  });
  return {
    tree,
    layout,
    issues,
    root: layout.root,
    ref: o.ref ?? null,
    commit: o.commit ?? null,
    folded,
    projection,
    numbering,
    options,
    decisions: o.decisions ?? null,
    sources: o.configured ?? [],
    source: o.source ?? null,
    findings,
    notes: o.notes ?? [],
  };
}

/**
 * The cached issue log of the `[[sources]]` entry `name`, for `issues list --source` and `issues
 * search --source` (cache only, never the network), numbered from its committed `index.md`. An
 * uncached source reads as an empty log with the note `<name> not fetched; run issues sources
 * fetch`. Throws `UsageError` for a name that isn't configured or names a decision log.
 */
export async function readSourceIssues(log: IssueLog, name: string): Promise<IssuesRead> {
  return withGitOperation(async () => {
    if (!isSourceName(name)) {
      throw new UsageError(`--source must match ^${SOURCE_NAME}$: ${name}`);
    }
    const configs = log.config?.sources ?? [];
    const config = configs.find((s) => s.name === name);
    if (config === undefined) {
      const known = configs.map((s) => s.name);
      throw new UsageError(
        known.length === 0
          ? `unknown source ${name}; there are no sources`
          : `unknown source ${name}; the sources are ${known.join(", ")}`,
      );
    }
    if (config.kind !== "issues") {
      throw new UsageError(`source ${name} is a decision log; --source reads issue logs`);
    }
    const r = await readSourceLog(log.git, config, {
      kind: issueKind,
      notFetched: `${name} not fetched; run issues sources fetch`,
    });
    return readIssuesFrom(r.tree, {
      issues: log.issues,
      sources: null,
      source: name,
      layout: r.layout,
      numbering: r.numbering,
      commit: r.commit,
      notes: [...log.notes, ...r.notes],
    });
  });
}

/**
 * The note a read command adds when issue numbers are unavailable (`null` otherwise): a shallow
 * clone or a cached source without a committed index shows issues by id. A `--source` read of a
 * source that isn't fetched gets none; its "not fetched" note says why.
 */
export function numberingNote(read: IssuesRead): string | null {
  const n = read.numbering;
  if (n.available) return null;
  // Only a --source read of a source that isn't fetched has no-main-ref.
  if (read.source !== null && n.reason === "no-main-ref") return null;
  return `issue numbers are unavailable (${unavailableReason(n, read.source)}); issues display by id`;
}

/** The note when the decision log's numbers are unavailable; `null` otherwise. */
export function decisionsNote(read: IssuesRead): string | null {
  const n = read.decisions?.numbering;
  if (n === undefined || n.available) return null;
  return `decision numbers are unavailable (${unavailableReason(n)}); decisions display by id`;
}

/**
 * The note of reads in a log with `[[sources]]`: references into them are checked against the
 * local cache. `null` without `[[sources]]`.
 */
export function sourcesNote(read: Pick<IssuesRead, "sources">): string | null {
  if (read.sources.length === 0) return null;
  return `references into ${read.sources.join(", ")} are checked against cached copies; run issues sources fetch to update them`;
}

/** `read.notes`, then the numbering, decision-numbering and sources notes that apply. */
export function readNotes(read: IssuesRead): readonly string[] {
  const extra = [numberingNote(read), decisionsNote(read), sourcesNote(read)];
  return [...read.notes, ...extra.filter((n): n is string => n !== null)];
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

const malformed = (s: string) => s === "" || s.length > 64 || hasControlChar(s);

/** `UsageError` unless the subject `id` has folded state. */
function requireFolded(read: IssuesRead, id: string): string {
  if (read.projection.views.has(id)) return id;
  if (read.projection.unreadable.includes(id)) {
    throw new UsageError(`issue ${id} uses a newer format; upgrade issues`);
  }
  throw new UsageError(`${id} has no valid opened event; run issues verify`);
}

/**
 * The id an issue argument names: an id, or a number as `42`, `?42` or `0042`. Throws
 * `UsageError` (exit 2) naming the reason when it names no folded issue of this log.
 */
export function resolveIssue(read: IssuesRead, input: string): string {
  const r = resolveSubjectInput(input, {
    subjects: new Set(read.folded.subjects.keys()),
    kind: issueKind,
    numbering: read.numbering,
  });
  if (r.ok) return requireFolded(read, r.id);
  const shown = input.trim();
  switch (r.reason) {
    case "malformed":
      throw new UsageError(`invalid issue ${JSON.stringify(input)}`);
    case "qualified":
      throw new UsageError(`${shown} is in another log; an issue is changed only in its own log`);
    case "numbers-unavailable":
      throw new UsageError(
        `issue numbers are unavailable (${unavailableReason(read.numbering, read.source)}); use the issue's id instead of ${shown}`,
      );
    case "not-found":
      throw new UsageError(`unknown issue ${shown}`);
  }
}

const DECISION_NUMBER = /^adr-?[0-9]+$/i;

/** The decision `input` names in the local decision log, as its id. */
function resolveDecision(read: IssuesRead, input: string): string {
  const d = read.decisions;
  if (d === null) throw new UsageError("no decision log in this repository (docs/adr)");
  let id: string | null = null;
  if (d.ids.has(input)) {
    id = input;
  } else {
    const n = parseDecisionNumber(input);
    if (n !== null) {
      if (!d.numbering.available) {
        throw new UsageError(
          `decision numbers are unavailable (${unavailableReason(d.numbering)}); use the decision's id instead of ${input}`,
        );
      }
      id = d.numbering.byNumber.get(n) ?? null;
    }
  }
  if (id === null || !d.ids.has(id)) {
    if (read.folded.subjects.has(input)) {
      throw new UsageError(`${input} is an issue; implements needs a decision`);
    }
    throw new UsageError(`unknown decision ${input} in ${d.root}`);
  }
  if (!d.views.has(id)) throw new UsageError(`decision ${id} doesn't fold; run adr verify`);
  return id;
}

/**
 * The stored form of a relation target (design "Reference forms"): a local issue id, a decision
 * of the local log as `adr:<id>` (for `implements`), or a qualified id of a configured source as
 * given. Throws `UsageError` (exit 2) for a target that names nothing or the wrong kind.
 */
export function resolveTarget(read: IssuesRead, input: string, rel: Rel): string {
  const s = input.trim();
  if (malformed(s)) throw new UsageError(`invalid target ${JSON.stringify(input)}`);
  const sources = read.options.sources ?? new Map<string, SourceLog>();
  const at = s.indexOf(":");
  if (rel === "implements") {
    if (at >= 0) {
      const name = s.slice(0, at);
      const rest = s.slice(at + 1);
      if (name === "adr") return `adr:${resolveDecision(read, rest)}`;
      const source = sources.get(name);
      if (source === undefined || source.local) {
        throw new UsageError(`unknown source ${name}; add a [[sources]] entry named ${name}`);
      }
      if (source.kind !== "adr")
        throw new UsageError(`${s} is an issue; implements needs a decision`);
      if (!isSubjectId(rest)) {
        throw new UsageError(`use the id in ${s}; numbers in other logs need their history`);
      }
      return s;
    }
    if (s.startsWith("?")) throw new UsageError(`${s} is an issue; implements needs a decision`);
    return `adr:${resolveDecision(read, s)}`;
  }
  if (at >= 0) {
    const name = s.slice(0, at);
    const rest = s.slice(at + 1);
    const source = name === "adr" ? null : sources.get(name);
    if (name === "adr" || source?.kind === "adr") {
      throw new UsageError(`${rel} needs an issue, and ${s} is a decision`);
    }
    if (source === undefined || source === null) {
      throw new UsageError(`unknown source ${name}; add a [[sources]] entry named ${name}`);
    }
    if (!isSubjectId(rest)) {
      throw new UsageError(`use the id in ${s}; numbers in other logs need their history`);
    }
    return s;
  }
  if (DECISION_NUMBER.test(s))
    throw new UsageError(`${rel} needs an issue, and ${s} is a decision`);
  return resolveIssue(read, s);
}

/**
 * ledger's `changedSince` (`issues list --since <rev>`: the event files added since `rev`, as
 * adr's) and `unavailableReason`, under issues' names.
 */
export { type ChangedSince, changedSince, unavailableReason } from "@nikovirtala/ledger";
