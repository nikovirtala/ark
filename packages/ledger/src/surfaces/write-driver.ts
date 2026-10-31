/**
 * The write driver a tool's writes share (adr §5.4): check the log and the identity, plan, apply
 * with the single `EventExistsError` retry, and report the views read again after a commit, plus
 * the editor step `new` runs between staging and committing. Each tool keeps its own JSON format
 * through the document builders it passes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CommitFailedError,
  ConfigError,
  EventExistsError,
  InvalidArgumentError,
} from "../errors.js";
import type { Finding } from "../findings/finding.js";
import type { Git } from "../git/git.js";
import { invalidateGitOperation, withGitOperation } from "../git/operation.js";
import { lintDocument } from "../templates/lint.js";
import type { Template } from "../templates/parse.js";
import { historyTemplates, type TemplateSource } from "../templates/source.js";
import { templateHistoryRef } from "../verify/template-check.js";
import type { AfterStage, AppliedPlan, WritePlan } from "./apply-plan.js";
import type { ToolLog } from "./tool-log.js";

/** The draft `new` stages and the editor step opens. */
export interface DraftFile {
  /** Repo-relative path of the body. */
  readonly path: string;
  /** The bytes the plan rendered and staged. */
  readonly rendered: Uint8Array;
  /** The template the draft is linted against. */
  readonly template: Template;
}

/** What the driver reads of a plan besides `applyPlan`'s `WritePlan`. */
export interface DriverPlan extends WritePlan {
  /** The parts of the commit message; `null` for a write that can't be committed. */
  readonly commit: unknown;
  /** For `new`: the draft the editor step opens; `null` otherwise. */
  readonly draft: DraftFile | null;
}

/** A refused plan: the findings that refuse it, and notes of the tool's own. */
export interface PlanRefusal {
  readonly ok: false;
  readonly findings: readonly Finding[];
  readonly notes?: readonly string[];
}

/** The clock and the randomness a write plans with; tests pass their own. */
export interface PlanDeps {
  readonly now: () => number;
  readonly random?: (buf: Uint8Array) => void;
}

/** What a plan needs besides the read: a clock, randomness and templates. */
export interface PlanContext extends PlanDeps {
  /** Recorded template versions: the work tree's, else the history's. */
  readonly templates: TemplateSource;
  /** Built-in template texts by name, for `new`. */
  readonly builtins: Readonly<Record<string, string>>;
}

/** The primary view of a write and the other views it changed. */
export interface WriteViews<V> {
  readonly primary: V | null;
  readonly affected: readonly V[];
}

/** What a write did, for the tool's document. */
export interface WriteOutcome<V> extends WriteViews<V> {
  /** Repo-relative paths written, in write order; `[]` when nothing was written. */
  readonly written: readonly string[];
  readonly commit: string | null;
  readonly findings: readonly Finding[];
  /** The log's notes, the caller's, the plan's, `applyPlan`'s, then the shortened-subject note. */
  readonly notes: readonly string[];
}

/** `runWrite`'s inputs: the log and the call's options, then the tool's bindings. */
export interface RunWriteOptions<
  R extends { readonly root: string },
  P extends DriverPlan,
  F extends PlanRefusal,
  V extends { readonly id: string },
  D,
> {
  readonly log: Pick<ToolLog, "git" | "ref" | "tree" | "notes">;
  /** `[policy] auto_commit`, the default of `commit`. */
  readonly autoCommit: boolean;
  /** Commit the write; default `autoCommit`. */
  readonly commit?: boolean;
  /** Notes to report before the write's own, such as the attribution notes. */
  readonly notes?: readonly string[];
  /** Report the plan as written, like a plan with nothing to write, without touching the repository. */
  readonly dryRun?: boolean;
  /** A commit of a plan without `commit` parts is an `InvalidArgumentError`, before anything is written. */
  readonly requireCommitParts?: boolean;
  readonly deps: PlanDeps;
  /** Built-in template texts by name, for the plan context. */
  readonly builtins: Readonly<Record<string, string>>;
  /** Reads the log from the work tree, again on each attempt. */
  readonly read: () => Promise<R>;
  readonly plan: (read: R, c: PlanContext) => Promise<{ readonly ok: true; readonly plan: P } | F>;
  /** Applies the plan, with `commit` resolved (the tool's message, editor step and index). */
  readonly apply: (plan: P, read: R, commit: boolean) => Promise<AppliedPlan>;
  /** The plan's own views, folded on the overlay. */
  readonly views: (plan: P) => WriteViews<V>;
  /** The views of the log read again at a new commit. */
  readonly reread: (sha: string) => Promise<ReadonlyMap<string, V>>;
  /** The tool's document for a refused plan, with the notes to report. */
  readonly refused: (r: F, notes: readonly string[]) => D;
  /** The tool's document for a plan written (or reported as written). */
  readonly done: (outcome: WriteOutcome<V>) => D;
  /** Notes of a refusal to report after the caller's; default none. */
  readonly refusalNotes?: (r: F) => readonly string[];
}

/**
 * `--commit` needs an author and a committer identity; checked before anything is written, since
 * `GIT_AUTHOR_*` alone satisfies the author while `git commit` still fails on the committer.
 */
export async function checkCommitIdentity(git: Pick<Git, "identity" | "committerIdentity">) {
  if ((await git.identity()) === null || (await git.committerIdentity()) === null) {
    throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
  }
}

/** Writes read the work tree: an `InvalidArgumentError` for a log opened at a ref or another tree. */
export function checkWorkTree(log: Pick<ToolLog, "ref" | "tree">): void {
  if (log.ref !== null) {
    throw new InvalidArgumentError("writes read the work tree; open the log without a ref");
  }
  if (log.tree.label !== "worktree") {
    throw new InvalidArgumentError(
      "writes read the work tree; open the log with the worktree reader",
    );
  }
}

/** The plan context of a log rooted at `root`: `deps`, `builtins` and its templates' history. */
export async function planContext(
  log: Pick<ToolLog, "git" | "tree">,
  root: string,
  builtins: Readonly<Record<string, string>>,
  deps: PlanDeps,
): Promise<PlanContext> {
  const ref = await templateHistoryRef(log.git, { type: "full" });
  return {
    now: deps.now,
    ...(deps.random === undefined ? {} : { random: deps.random }),
    templates: historyTemplates(log.git, log.tree, `${root}/templates`, { ref }),
    builtins,
  };
}

/** Whether two byte arrays hold the same bytes. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

/** The bytes of the file at `path`, or `null` when there is none. */
export async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The views a write reports. Without a commit (`sha` null) they are the plan's, folded on the
 * overlay. After a commit they come from `reread(sha)`, so a commit on the main ref shows the
 * numbers it assigned; a view the new read lacks stays the plan's.
 */
export async function viewsAfter<V extends { readonly id: string }>(
  sha: string | null,
  views: WriteViews<V>,
  reread: (sha: string) => Promise<ReadonlyMap<string, V>>,
): Promise<WriteViews<V>> {
  if (sha === null) return views;
  const now = await reread(sha);
  const view = (v: V) => now.get(v.id) ?? v;
  return {
    primary: views.primary === null ? null : view(views.primary),
    affected: views.affected.map(view),
  };
}

/**
 * Plan, then apply, with the single `EventExistsError` retry (§5.4 steps 1–5): checks the work
 * tree and, when committing, the identity; plans on a fresh read and plan context; reports a
 * refusal with `refused`; reports a plan with no files and no events, and every plan with
 * `dryRun`, as written without touching the repository (its views are the plan's); otherwise
 * applies it and reports `done` with the views read again after a commit. A `CommitFailedError`
 * gets the notes a successful write would have reported first.
 */
export function runWrite<
  R extends { readonly root: string },
  P extends DriverPlan,
  F extends PlanRefusal,
  V extends { readonly id: string },
  D,
>(o: RunWriteOptions<R, P, F, V, D>): Promise<D> {
  const { log } = o;
  return withGitOperation(async () => {
    checkWorkTree(log);
    const commit = o.commit ?? o.autoCommit;
    if (commit) await checkCommitIdentity(log.git);
    const notes = [...log.notes, ...(o.notes ?? [])];
    for (let attempt = 0; ; attempt++) {
      const read = await o.read();
      const r = await o.plan(read, await planContext(log, read.root, o.builtins, o.deps));
      if (!r.ok) {
        const refused = r as F;
        return o.refused(refused, [...notes, ...(o.refusalNotes?.(refused) ?? [])]);
      }
      const { plan } = r as { readonly plan: P };
      const empty =
        plan.events.length === 0 &&
        Object.keys(plan.files).length === 0 &&
        Object.keys(plan.replace ?? {}).length === 0;
      if (empty || o.dryRun === true) {
        return o.done({
          ...o.views(plan),
          written: [],
          commit: null,
          findings: plan.findings,
          notes: [...notes, ...(plan.notes ?? [])],
        });
      }
      if (o.requireCommitParts === true && commit && plan.commit === null) {
        throw new InvalidArgumentError("this write can't be committed");
      }
      try {
        const applied = await o.apply(plan, read, commit);
        const views = await viewsAfter(applied.commit, o.views(plan), o.reread);
        return o.done({
          ...views,
          written: applied.written,
          commit: applied.commit,
          findings: applied.findings,
          notes: [
            ...notes,
            ...(plan.notes ?? []),
            ...applied.notes,
            ...(applied.commit !== null && applied.rendered?.note != null
              ? [applied.rendered.note]
              : []),
          ],
        });
      } catch (err) {
        // A refused commit keeps the notes a successful write would report, before applyPlan's.
        if (err instanceof CommitFailedError)
          throw err.withNotes([...notes, ...(plan.notes ?? [])]);
        // Another process wrote the same event path in the same instant: writeEvents removed this
        // batch and applyPlan the new body and template, so plan again with a fresh clock, once.
        if (!(err instanceof EventExistsError) || attempt > 0) throw err;
      }
    }
  });
}

/** `editorStep`'s inputs. */
export interface EditorStepOptions {
  readonly git: Pick<Git, "root" | "add" | "unstagedPaths">;
  /** Runs the editor on an absolute path: `null` when it exited 0, else a note for the user. */
  readonly edit: (absPath: string) => Promise<string | null>;
  /** Receives the notes about a skipped commit or a removed body. */
  readonly onNote?: (note: string) => void;
  /** Also pass the editor's own note to `onNote` when it failed (issues does, adr doesn't). */
  readonly editorNotes?: boolean;
  /** Maps each lint finding of the draft, such as setting its kind. */
  readonly finding?: (f: Finding) => Finding;
}

/**
 * The editor step (§5.4 step 4a), for `applyPlan`'s `afterStage`: runs `edit` on the staged draft,
 * re-stages the edited body when the editor exited 0, and skips the commit when committing would
 * take content nobody confirmed: the body changed while the editor failed, the body is gone, or
 * another path in the commit scope (a materialized template, say) changed while the editor was
 * open. A draft with unfilled required sections is never committed; it stays staged. The findings
 * are the lint of the draft as it now is. A plan without a draft keeps its findings and commit.
 */
export function editorStep(
  o: EditorStepOptions,
): (
  plan: DriverPlan,
  commitRequested: boolean,
) => (scope: readonly string[]) => Promise<AfterStage> {
  const decoder = new TextDecoder();
  return (plan, commitRequested) => async (scope) => {
    const d = plan.draft;
    if (d === null) return { findings: null, commit: true };
    const abs = join(o.git.root ?? "", d.path);
    const note = await o.edit(abs);
    // The editor may run other processes or wait on a person: drop what the operation cached.
    invalidateGitOperation();
    const bytes = await readIfPresent(abs);
    let commit: boolean;
    if (bytes === null) {
      commit = false;
      o.onNote?.(
        `${d.path} was removed while editing; the rendered draft is still staged. Restore it with \`git checkout -- ${d.path}\``,
      );
    } else if (note === null) {
      await o.git.add([d.path]);
      commit = true;
    } else if (sameBytes(bytes, d.rendered)) {
      if (o.editorNotes === true) o.onNote?.(note);
      commit = true;
    } else {
      commit = false;
      if (o.editorNotes === true) o.onNote?.(note);
      if (commitRequested) {
        o.onNote?.(
          `${d.path} changed while the editor failed; review it, then git add it and commit`,
        );
      }
    }
    if (commit && commitRequested) {
      // The whole scope the commit takes, which `applyPlan` passes.
      const late = (await o.git.unstagedPaths(scope)).filter((p) => p !== d.path);
      const [first] = late;
      if (first !== undefined) {
        commit = false;
        o.onNote?.(
          `${first} changed while the editor was open; review it, then git add it and commit`,
        );
      }
    }
    const text = decoder.decode(bytes ?? d.rendered);
    const linted = lintDocument(d.template, text, { file: d.path, subject: plan.subject });
    const findings = o.finding === undefined ? linted : linted.map(o.finding);
    if (commit && commitRequested && findings.length > 0) {
      commit = false;
      o.onNote?.(`${d.path} still has unfilled required sections; fill them in, then commit`);
    }
    return { findings, commit };
  };
}
