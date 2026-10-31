import { join } from "node:path";
import {
  type Actor,
  type CommitSlot,
  checkCommitIdentity,
  checkWorkTree,
  editorStep,
  type Finding,
  InvalidArgumentError,
  indexReader,
  invalidateGitOperation,
  type RenderedCommit,
  readIfPresent,
  refReader,
  renderCommitMessage,
  runWrite,
  type SetOp,
  sameBytes,
  stagedRenames,
  type TreeReader,
  UsageError,
  viewsAfter,
  withGitOperation,
} from "@nikovirtala/ledger";
import { type AfterStage, applyPlan, type ComposeInput } from "./apply.js";
import { ACTIONS, composeSubject, UPDATE_ACTION } from "./commit-actions.js";
import { bodyTitle } from "./kind/project.js";
import { type IssueView, issueKind } from "./kind.js";
import { type IssueLog, type IssuesRead, readIssues, resolveIssue } from "./log.js";
import { renderIssueIndex } from "./log-index.js";
import {
  type CloseInput,
  type EditInput,
  type LinkInput,
  type OpenInput,
  type PlanContext,
  type PlanResult,
  planClose,
  planComment,
  planEdit,
  planFollowRenames,
  planLink,
  planOpen,
  planReopen,
  planSet,
  planStart,
  planStop,
  planUnlink,
  reachOf,
  type SetKind,
  type StagedRenames,
  slotOf,
  type WriteCommand,
  type WritePlan,
} from "./plan.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

/** `issues <write command> --json`. */
export interface IssueWriteJson {
  readonly format: "issues-write/v1";
  readonly command: WriteCommand;
  readonly ok: boolean;
  /**
   * The issue after the write; before it when `ok` is false (`null` for a refused `new`). After
   * a commit it is read again, so an issue opened on the main ref carries its number.
   */
  readonly issue: IssueView | null;
  /** `link`/`unlink`: the local target; `close --duplicate-of`: the canonical issue. */
  readonly affected: readonly IssueView[];
  /** Repo-relative paths this command wrote, in write order. */
  readonly written: readonly string[];
  readonly commit: string | null;
  /** Refusal findings when `ok` is false; added warnings and `new`'s draft lint otherwise. */
  readonly findings: readonly Finding[];
  /** How the log was located, then the caller's notes (attribution), then the write's own. */
  readonly notes: readonly string[];
}

/** What every write function takes besides its input. */
export interface WriteOptions {
  /** Commit the write; default `[policy] auto_commit`. */
  readonly commit?: boolean;
  /** The commit message to use instead of the `[commit] subject` one; used only when committing. */
  readonly message?: string | null;
  /** Notes to report before the write's own, such as the attribution notes. */
  readonly notes?: readonly string[];
  /**
   * `"skip"` leaves `<root>/index.md` alone (the pre-commit hook's rename following, which
   * regenerates the index itself when asked to); default: kept fresh with `[log] index =
   * "committed"`.
   */
  readonly index?: "skip";
}

/** The clock, the randomness and `applyPlan` the write functions use; tests pass their own. */
export interface WriteDeps {
  readonly now: () => number;
  readonly random?: (buf: Uint8Array) => void;
  readonly apply: typeof applyPlan;
}
const DEFAULT_DEPS: WriteDeps = { now: Date.now, apply: applyPlan };

/** An editor run on an absolute path: `null` when it exited 0, else a note for the user. */
export type Editor = (absPath: string) => Promise<string | null>;

/**
 * What every write passes `applyPlan` besides the plan: the commit and either the user's own
 * message (`-m`) or `compose`, which renders `[commit] subject` once the extra staged events are
 * known (?6), and, with `[log] index = "committed"`, the index render. `write()` and `editIssue`'s
 * editor branch both call `deps.apply` with it, so tests' apply seams cover both.
 */
function applyOptions(
  log: IssueLog,
  command: WriteCommand,
  plan: WritePlan,
  o: WriteOptions & { readonly commit: boolean },
): Parameters<typeof applyPlan>[2] {
  const given = o.message ?? null;
  return {
    commit: o.commit,
    ...(!o.commit
      ? {}
      : given !== null
        ? { message: given, mergeTrailers: true }
        : { compose: (c: ComposeInput) => commitMessage(log, command, plan, c) }),
    ...(log.issues.index === "committed" && o.index !== "skip"
      ? {
          index: (tree: TreeReader, history: string | null) =>
            renderIssueIndex(log.git, { layout: log.layout, issues: log.issues, tree, history }),
        }
      : {}),
  };
}

/**
 * The plan's commit message from `[commit] subject` (?6): the slot holds the command's issue as
 * `<display> "<title>"` (`new`: the title alone), with the title the commit's tree holds (an
 * edited heading; HEAD's when a staged retitle stays out of the commit), then the action's own
 * words. A batch of extra staged events of other types gets `composeSubject`'s joined verbs and
 * name instead; where a custom template can't fit them, `update`.
 */
async function commitMessage(
  log: IssueLog,
  command: WriteCommand,
  plan: WritePlan,
  c: ComposeInput,
): Promise<RenderedCommit> {
  const parts = plan.commit;
  if (parts === null) throw new InvalidArgumentError("this write can't be committed");
  const path = plan.draft?.path ?? plan.issue?.body_path ?? null;
  const bytes = path === null ? null : await c.tree.read(path);
  const title = (bytes === null ? null : bodyTitle(bytes)) ?? parts.title;
  const render = (action: string, t: string, slot: CommitSlot | undefined) =>
    renderCommitMessage(log.issues.commitSubject, {
      title: t,
      vars: { action, id: parts.id, display: parts.display, command },
      body: parts.body,
      ...(slot === undefined ? {} : { slot }),
    });
  const single = render(parts.action, title, {
    before: parts.before,
    after: parts.after,
    quote: parts.quote,
  });
  const batch = composeSubject({
    command,
    subject: plan.subject,
    display: parts.display,
    plan: c.plan,
    extra: c.extra,
  });
  if (batch === null) return single;
  const named = (action: string) =>
    batch.name === null
      ? render(action, title, { before: parts.before, quote: true })
      : render(action, batch.name, undefined);
  const r = named(batch.action);
  // The several-issues name is never shortened: a template too long for the joined verbs gets
  // `update`.
  return r.shortened && batch.name !== null ? named(UPDATE_ACTION) : r;
}

/** The views of `issues-write/v1`: the plan's issue and the issues it affected. */
const viewsOf = (plan: WritePlan) => ({ primary: plan.issue, affected: plan.affected });

/** The views of the log read again at `sha`, so a commit on the main ref shows its numbers. */
const reread = (log: IssueLog) => async (sha: string) =>
  (await readIssues({ ...log, commit: sha })).projection.views;

/**
 * Plan, then apply, with ledger's `runWrite` and the `issues-write/v1` document: one retry on
 * `EventExistsError` (another process wrote the same event path in the same instant).
 * `o.message` replaces the rendered commit message; `o.notes` come before the write's own, and a
 * refusal's own notes after them. A plan with nothing to write, and every plan with `dryRun`, is
 * reported without touching the repository.
 */
function write(
  log: IssueLog,
  command: WriteCommand,
  plan: (read: IssuesRead, c: PlanContext) => Promise<PlanResult>,
  o: WriteOptions & { readonly dryRun?: boolean },
  deps: WriteDeps,
  afterStage?: (
    plan: WritePlan,
    commit: boolean,
  ) => (scope: readonly string[]) => Promise<AfterStage>,
): Promise<IssueWriteJson> {
  return runWrite<
    IssuesRead,
    WritePlan,
    Extract<PlanResult, { ok: false }>,
    IssueView,
    IssueWriteJson
  >({
    log,
    autoCommit: log.issues.autoCommit,
    ...(o.commit === undefined ? {} : { commit: o.commit }),
    ...(o.notes === undefined ? {} : { notes: o.notes }),
    ...(o.dryRun === undefined ? {} : { dryRun: o.dryRun }),
    deps,
    builtins: BUILTIN_TEMPLATES,
    read: () => readIssues(log),
    plan,
    apply: (p, _read, commit) =>
      deps.apply(log, p, {
        ...applyOptions(log, command, p, { ...o, commit }),
        ...(afterStage === undefined ? {} : { afterStage: afterStage(p, commit) }),
      }),
    views: viewsOf,
    reread: reread(log),
    refusalNotes: (r) => r.notes ?? [],
    refused: (r, notes) => ({
      format: "issues-write/v1",
      command,
      ok: false,
      issue: r.issue,
      affected: [],
      written: [],
      commit: null,
      findings: r.findings,
      notes,
    }),
    done: (w) => ({
      format: "issues-write/v1",
      command,
      ok: true,
      issue: w.primary,
      affected: w.affected,
      written: w.written,
      commit: w.commit,
      findings: w.findings,
      notes: w.notes,
    }),
  });
}

/**
 * `issues new`: renders a draft, writes the body, any materialized template and the `opened`
 * (plus `labeled` and `linked`) events, stages them, and commits with `commit` (default
 * `[policy] auto_commit`). `edit` (CLI only) runs between staging and committing. A draft with
 * unfilled sections is never committed: without `edit` a commit is refused (`ok: false`, nothing
 * written); after `edit` the commit is skipped with a note through `onNote`.
 */
export async function openIssue(
  log: IssueLog,
  input: OpenInput,
  o: WriteOptions & { readonly edit?: Editor; readonly onNote?: (note: string) => void } = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  const notes: string[] = [];
  const onNote = (note: string) => {
    notes.push(note);
    o.onNote?.(note);
  };
  const doc = await write(
    log,
    "new",
    (read, c) =>
      planOpen(read, input, c, {
        refuseIncomplete: (o.commit ?? log.issues.autoCommit) && o.edit === undefined,
      }),
    o,
    deps,
    o.edit === undefined
      ? undefined
      : editorStep({
          git: log.git,
          edit: o.edit,
          onNote,
          editorNotes: true,
          finding: (f) => ({ ...f, kind: issueKind.name }),
        }),
  );
  return notes.length === 0 ? doc : { ...doc, notes: [...doc.notes, ...notes] };
}

/**
 * `issues edit`: with `title` or `sections`, replaces the `# ` heading and the sections in the
 * body; without them, runs `o.edit` on the body (a `UsageError` without an editor). Stages the
 * body and, with `commit`, commits the body alone with an `Issue:` trailer. An unchanged body
 * writes nothing, with the note "nothing changed". `refuseIncomplete` (direct edits only) refuses
 * a body that fails template lint when the write commits; unstaged, it is staged as usual.
 */
export async function editIssue(
  log: IssueLog,
  input: EditInput & { readonly actor?: Actor },
  o: WriteOptions & { readonly edit?: Editor; readonly refuseIncomplete?: boolean } = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return withGitOperation(async () => {
    const direct = (input.title ?? null) !== null || Object.keys(input.sections ?? {}).length > 0;
    if (direct) {
      const refuseIncomplete = o.refuseIncomplete === true && (o.commit ?? log.issues.autoCommit);
      return write(
        log,
        "edit",
        (read, c) => planEdit(read, input, c, { refuseIncomplete }),
        o,
        deps,
      );
    }
    if (o.edit === undefined) throw new UsageError("no editor: set VISUAL or EDITOR");
    checkWorkTree(log);
    const commit = o.commit ?? log.issues.autoCommit;
    if (commit) await checkCommitIdentity(log.git);
    const notes = [...log.notes, ...(o.notes ?? [])];
    const read = await readIssues(log);
    const id = resolveIssue(read, input.id);
    const view = read.projection.views.get(id) as IssueView;
    const path = view.body_path;
    if (path === null) throw new UsageError(`${view.display} has no body file; run issues verify`);
    const abs = join(log.git.root ?? "", path);
    const before = await readIfPresent(abs);
    const note = await o.edit(abs);
    // The editor may run other processes or wait on a person: drop what the operation cached.
    invalidateGitOperation();
    const after = await readIfPresent(abs);
    const result = (extra: Partial<IssueWriteJson>): IssueWriteJson => ({
      format: "issues-write/v1",
      command: "edit",
      ok: true,
      issue: view,
      affected: [],
      written: [],
      commit: null,
      findings: [],
      notes,
      ...extra,
    });
    if (after === null) return result({ notes: [...notes, `${path} was removed while editing`] });
    if (before !== null && sameBytes(before, after)) {
      return result({ notes: [...notes, ...(note === null ? [] : [note]), "nothing changed"] });
    }
    if (note !== null) {
      return result({
        notes: [
          ...notes,
          note,
          `${path} changed while the editor failed; review it, then git add it`,
        ],
      });
    }
    await log.git.add([path]);
    // Through applyPlan like every other write: ?5's commit scope (an uncommitted `opened` of this
    // issue joins the commit) and the index, rendered from the edited body.
    const fresh = await readIssues(log);
    const now = fresh.projection.views.get(id) ?? view;
    const plan: WritePlan = {
      command: "edit",
      subject: id,
      files: {},
      events: [],
      stage: [path],
      commitScope: [path],
      eventDirs: [],
      reach: reachOf(fresh, id),
      draft: null,
      commit: slotOf(now, ACTIONS.edit),
      trailers: [["Issue", id]],
      issue: now,
      affected: [],
      findings: [],
    };
    const applied = await deps.apply(log, plan, applyOptions(log, "edit", plan, { ...o, commit }));
    const views = await viewsAfter(applied.commit, viewsOf(plan), reread(log));
    return result({
      issue: views.primary ?? now,
      written: [path, ...applied.written.filter((p) => p !== path)],
      commit: applied.commit,
      notes: [
        ...notes,
        ...applied.notes,
        ...(applied.commit !== null && applied.rendered?.note != null
          ? [applied.rendered.note]
          : []),
      ],
    });
  });
}

/**
 * `issues start`: writes `started` (and `assigned` with you when unassigned), noting each scope
 * glob that matches no tracked file, which verify reports from now on.
 */
export async function startIssue(
  log: IssueLog,
  input: { readonly id: string; readonly actor: Actor },
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  const tracked = (await (await indexReader(log.git)).list("")).map((e) => e.path);
  return write(log, "start", (read, c) => planStart(read, input, c, { tracked }), o, deps);
}

/** `issues stop`: writes `stopped`, with a reason when given. */
export function stopIssue(
  log: IssueLog,
  input: { readonly id: string; readonly reason?: string | null; readonly actor: Actor },
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return write(log, "stop", (read, c) => planStop(read, input, c), o, deps);
}

/** `issues close`: writes `closed`; the kind's rules refuse it (`ok: false`) when they forbid it. */
export function closeIssue(
  log: IssueLog,
  input: CloseInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return write(log, "close", (read, c) => planClose(read, input, c), o, deps);
}

/** `issues reopen`: writes `reopened`, whose reason is required. */
export function reopenIssue(
  log: IssueLog,
  input: { readonly id: string; readonly reason?: string | null; readonly actor: Actor },
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return write(log, "reopen", (read, c) => planReopen(read, input, c), o, deps);
}

/** Input of `assignIssue`, `labelIssue` and `scopeIssue`. */
export interface SetIssueInput {
  readonly id: string;
  readonly op: SetOp;
  readonly actor: Actor;
  /** How the caller names `set`, `add`, `remove` and `clear` in messages. */
  readonly names?: {
    readonly set: string;
    readonly add: string;
    readonly remove: string;
    readonly clear?: string;
  };
}

function setIssue(
  kind: SetKind,
  log: IssueLog,
  input: SetIssueInput,
  o: WriteOptions,
  deps: WriteDeps,
  tracked?: readonly string[],
) {
  return write(
    log,
    kind,
    (read, c) => planSet(read, kind, input, c, tracked === undefined ? {} : { tracked }),
    o,
    deps,
  );
}

/** `issues assign`: writes `assigned` with the new set; `me` is you. */
export function assignIssue(
  log: IssueLog,
  input: SetIssueInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return setIssue("assign", log, input, o, deps);
}

/** `issues label`: writes `labeled` with the new set, replacing labels of an exclusive prefix. */
export function labelIssue(
  log: IssueLog,
  input: SetIssueInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return setIssue("label", log, input, o, deps);
}

/** `issues scope`: writes `scoped` with the new globs, noting globs that match no tracked file. */
export async function scopeIssue(
  log: IssueLog,
  input: SetIssueInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  const tracked = (await (await indexReader(log.git)).list("")).map((e) => e.path);
  return setIssue("scope", log, input, o, deps, tracked);
}

/** `issues comment`: writes `commented`. */
export function commentIssue(
  log: IssueLog,
  input: { readonly id: string; readonly text: string; readonly actor: Actor },
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return write(log, "comment", (read, c) => planComment(read, input, c), o, deps);
}

/** `issues link`: writes `linked`; an existing link writes nothing. */
export function linkIssue(
  log: IssueLog,
  input: LinkInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return write(log, "link", (read, c) => planLink(read, input, c), o, deps);
}

/** `issues unlink`: writes `unlinked`; a link that isn't there writes nothing. */
export function unlinkIssue(
  log: IssueLog,
  input: LinkInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return write(log, "unlink", (read, c) => planUnlink(read, input, c), o, deps);
}

/** The paths of every file in `tree`. */
async function filePaths(tree: TreeReader): Promise<string[]> {
  return (await tree.list("")).filter((e) => e.type === "file").map((e) => e.path);
}

/**
 * `issues scope [<issue>] --follow-renames` (adr's `followScopeRenames`): rewrites the scope
 * globs of the given issue, or of every issue that isn't closed, after the renames staged against
 * `HEAD`, and stages one `scoped` event per changed issue. It never commits (the events belong in
 * the commit with the renames), so `o.commit: true` and a message are `InvalidArgumentError`s.
 * `dryRun` plans the same events and notes, writing nothing; `affected` lists the changed issues.
 */
export async function followScopeRenames(
  log: IssueLog,
  input: { readonly id?: string; readonly actor: Actor },
  o: WriteOptions & { readonly dryRun?: boolean } = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<IssueWriteJson> {
  return withGitOperation(async () => {
    if (o.commit === true) {
      throw new InvalidArgumentError("followScopeRenames never commits; don't pass commit: true");
    }
    if (o.message !== undefined && o.message !== null) {
      throw new InvalidArgumentError("followScopeRenames never commits, so it takes no message");
    }
    const renames = await stagedRenames(log.git);
    const staged: StagedRenames =
      renames.length === 0
        ? { renames, before: [], after: [] }
        : {
            renames,
            before: await filePaths(await refReader(log.git, "HEAD")),
            after: await filePaths(await indexReader(log.git)),
          };
    const plan = (read: IssuesRead, c: PlanContext) =>
      planFollowRenames(read, { id: input.id ?? null, actor: input.actor }, staged, c);
    // A dry run reports the plan without the note below.
    if (o.dryRun === true) {
      return write(log, "scope", plan, { ...o, commit: false, dryRun: true }, deps);
    }
    const doc = await write(log, "scope", plan, { ...o, commit: false, dryRun: false }, deps);
    return log.issues.autoCommit && doc.ok && doc.affected.length > 0
      ? {
          ...doc,
          notes: [
            ...doc.notes,
            "--follow-renames never commits; commit the scoped events with the renames",
          ],
        }
      : doc;
  });
}
