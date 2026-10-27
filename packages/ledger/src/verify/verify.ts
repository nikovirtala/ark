import { type CompiledKind, compileKind, type KindSchema } from "../envelope/kind.js";
import { InvalidArgumentError, RefNotFoundError, VerifyUsageError } from "../errors.js";
import { type Finding, sortFindings } from "../findings/finding.js";
import { foldLog } from "../fold/fold.js";
import type { Git } from "../git/git.js";
import { indexReader, refReader, type TreeReader, worktreeReader } from "../git/tree.js";
import { parseBodyFileName } from "../identity/files.js";
import { classifyPath, type LogLayout } from "../identity/layout.js";
import { isKind } from "../kind/define.js";
import { loadLog } from "../log/snapshot.js";
import { type Check, type CheckContext, mechanicalChecks, type RepoContext } from "./checks.js";
import { type Change, diffTrees } from "./diff.js";
import { foldChecks } from "./fold-checks.js";

export type VerifyMode =
  /** Base `HEAD` (none on an unborn `HEAD`), head the index; only touched subjects. */
  | { readonly type: "staged" }
  /** Base the merge base of `base` and `head ?? HEAD`; head the ref, or the work tree. */
  | { readonly type: "range"; readonly base: string; readonly head?: string }
  /** No base; head the ref, or the work tree. */
  | { readonly type: "full"; readonly head?: string };

/** The subject a changed path belongs to, if it names one. */
function subjectOf(layout: LogLayout, change: Change): string | null {
  const p = classifyPath(layout, change.path);
  if (p.area === "event") return p.subject;
  if (p.area === "body" && !p.file.includes("/")) return parseBodyFileName(p.file)?.id ?? null;
  return null;
}

/**
 * Verifies `head` against `base` (`null`: no base) with the given checks. Returns the findings
 * sorted, with `kind` filled in. For a `defineKind` kind, head and base are folded into
 * `ctx.folded` and the checks default to `foldChecks(kind)`; in scope `changed`, a kind with
 * `relate` loads the whole head log, since relations need the subjects they refer to. Other kinds
 * default to `mechanicalChecks`.
 */
export async function verifySnapshots(o: {
  readonly kind: CompiledKind;
  readonly layout: LogLayout;
  readonly base: TreeReader | null;
  readonly head: TreeReader;
  readonly scope: "changed" | "all";
  readonly checks?: readonly Check[];
  /** Passed to the checks as `ctx.repo`; checks over code report nothing without it. */
  readonly repo?: RepoContext;
}): Promise<Finding[]> {
  const { kind, layout, scope } = o;
  if ((kind.kind.body === "none") !== (layout.bodies === null)) {
    throw new InvalidArgumentError(
      `kind ${kind.kind.name} body policy and layout bodies must both be set or both be absent`,
    );
  }
  const changes = await diffTrees(o.base, o.head, layout.root);
  const changed = new Set<string>();
  const baseNeeded = new Set<string>();
  for (const c of changes) {
    const id = subjectOf(layout, c);
    if (id === null) continue;
    changed.add(id);
    const area = classifyPath(layout, c.path).area;
    if (area === "body" || (area === "event" && c.status === "deleted")) baseNeeded.add(id);
  }
  const defined = isKind(kind.kind) ? kind.kind : null;
  const whole = scope === "all" || defined?.def.relate !== undefined;
  const head = whole
    ? await loadLog(o.head, { kind, layout })
    : await loadLog(o.head, { kind, layout, subjects: changed });
  const inScope = scope === "all" ? new Set([...head.subjects.keys(), ...changed]) : changed;
  const base =
    o.base === null ? null : await loadLog(o.base, { kind, layout, subjects: baseNeeded });
  const folded =
    defined === null
      ? null
      : {
          head: foldLog(defined, head),
          base: base === null ? null : foldLog(defined, base),
        };
  const ctx: CheckContext = {
    kind,
    layout,
    base,
    head,
    changes,
    scope,
    inScope,
    folded,
    ...(o.repo === undefined ? {} : { repo: o.repo }),
  };

  const checks = o.checks ?? (defined === null ? mechanicalChecks : foldChecks(defined));
  const findings: Finding[] = [];
  for (const check of checks) findings.push(...(await check.run(ctx)));
  return sortFindings(findings.map((f) => ({ ...f, kind: kind.kind.name })));
}

async function commitOf(git: Git, ref: string): Promise<string> {
  const sha = await git.resolveCommit(ref);
  if (sha === null) throw new RefNotFoundError(ref);
  return sha;
}

/**
 * The entries of `widenOn` (repo-relative paths; a trailing `/` means anything under it) that the
 * staged changes touch: the paths changed between `HEAD` (none on an unborn `HEAD`) and the index,
 * deletions included, that equal an entry or lie under a `/` entry. In path order; `[]` outside
 * `staged` mode or for an empty `widenOn`.
 */
export async function touchedInputs(
  git: Git,
  mode: VerifyMode,
  widenOn: readonly string[],
): Promise<string[]> {
  if (mode.type !== "staged" || widenOn.length === 0) return [];
  const sha = await git.resolveCommit("HEAD");
  const changed = await git.changedPaths(sha, "index");
  return changed.filter((p) => widenOn.some((w) => (w.endsWith("/") ? p.startsWith(w) : p === w)));
}

/**
 * Verifies a log in a repository. `staged` checks the subjects touched by the index against
 * `HEAD`; `range` checks everything from the merge base to the head; `full` checks a single tree.
 * In `staged` mode, when the staged changes touch an entry of `widenOn` (`touchedInputs`), every
 * subject is in scope, because a checked input outside the log (a config, a template, another
 * log) changed.
 */
export async function verifyLog(o: {
  readonly git: Git;
  readonly kind: KindSchema;
  readonly layout: LogLayout;
  readonly mode: VerifyMode;
  readonly checks?: readonly Check[];
  /** Inputs outside the log whose staged change widens a `staged` verify to every subject. */
  readonly widenOn?: readonly string[];
}): Promise<Finding[]> {
  const { git, mode } = o;
  let base: TreeReader | null;
  let head: TreeReader;
  let scope: "changed" | "all" = "all";
  let repo: RepoContext;
  if (mode.type === "staged") {
    head = await indexReader(git);
    const sha = await git.resolveCommit("HEAD");
    base = sha === null ? null : await refReader(git, sha);
    const touched = await touchedInputs(git, mode, o.widenOn ?? []);
    scope = touched.length === 0 ? "changed" : "all";
    repo = { git, mode: "staged", head: "index", base: sha };
  } else if (mode.type === "range") {
    const baseSha = await commitOf(git, mode.base);
    const headSha = await commitOf(git, mode.head ?? "HEAD");
    const mergeBase = await git.mergeBase(baseSha, headSha);
    if (mergeBase === null) {
      throw new VerifyUsageError(
        `no common ancestor between ${mode.base} and ${mode.head ?? "HEAD"}`,
      );
    }
    base = await refReader(git, mergeBase);
    head = mode.head === undefined ? worktreeReader(git) : await refReader(git, mode.head);
    repo = {
      git,
      mode: "range",
      head: mode.head === undefined ? "worktree" : { commit: headSha },
      base: mergeBase,
    };
  } else {
    base = null;
    head = mode.head === undefined ? worktreeReader(git) : await refReader(git, mode.head);
    repo = {
      git,
      mode: "full",
      head: head.commit === null ? "worktree" : { commit: head.commit },
      base: null,
    };
  }
  return verifySnapshots({
    kind: compileKind(o.kind),
    layout: o.layout,
    base,
    head,
    scope,
    repo,
    ...(o.checks === undefined ? {} : { checks: o.checks }),
  });
}
