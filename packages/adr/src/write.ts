import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Actor,
  type AfterStage,
  type AppliedPlan,
  applySetOp,
  bodyFileName,
  bodySha256,
  CommitFailedError,
  type ComposeInput,
  ConfigError,
  checkReason,
  checkText,
  chooseTemplate,
  compileKind,
  type EventEnvelope,
  EventExistsError,
  type EventRef,
  eventDir,
  eventFiles,
  eventPairs,
  extractSections,
  FileExistsError,
  type Finding,
  followRenamesChanges,
  historyTemplates,
  type IndexRender,
  InvalidArgumentError,
  indexReader,
  invalidateGitOperation,
  isSourceName,
  isSubjectId,
  joinActions,
  type WritePlan as LedgerWritePlan,
  applyPlan as ledgerApplyPlan,
  newEvent as ledgerNewEvent,
  precheck as ledgerPrecheck,
  refusal as ledgerRefusal,
  lintDocument,
  newSubjectId,
  parseGlob,
  type RenderedCommit,
  refReader,
  renderCommitMessage,
  renderTemplate,
  replaceSections,
  type SetOp,
  type StagedRenames,
  slugify,
  stagedRenames,
  subjectView,
  type Template,
  type TemplateSource,
  type Trailer,
  type TreeReader,
  templateHistoryRef,
  UsageError,
  unmatchedGlobs,
  withGitOperation,
} from "@nikovirtala/ledger";
import {
  ACTIONS,
  BATCH_ACTIONS,
  BATCH_ORDER,
  CROSS_LOG_LINK,
  DRAFT_ACTION,
  UPDATE_ACTION,
} from "./commit-actions.js";
import { type AdrSource, adrKind, type DecisionView, type LinkRel } from "./kind.js";
import {
  type DecisionLog,
  type DecisionsRead,
  readDecisions,
  readDecisionsFrom,
  resolveDecision,
} from "./log.js";
import { renderDecisionIndex } from "./log-index.js";
import { readDecisionSources } from "./sources.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

export { type AfterStage, type AppliedPlan, WRITE_RERUN } from "@nikovirtala/ledger";

/** `adr <write command> --json` (design §5.5, §6.1). */
export interface WriteResultJson {
  readonly format: "adr-write/v1";
  readonly command:
    | "new"
    | "accept"
    | "supersede"
    | "reject"
    | "withdraw"
    | "deprecate"
    | "note"
    | "link"
    | "scope"
    | "update";
  readonly ok: boolean;
  /**
   * The decision after the write; before it when `ok` is false (`null` for a refused `new`).
   * After a commit it is read again from the log, so an acceptance committed on the main ref
   * carries its number; otherwise `number` is `null` until the acceptance lands on main. In a
   * shallow clone with a committed index, the number comes from HEAD's `index.md`, which on a
   * branch is the number the decision will get once the branch merges.
   */
  readonly decision: DecisionView | null;
  /** Each decision superseded by this write, after it (read again after a commit, like `decision`). */
  readonly affected: readonly DecisionView[];
  /** Repo-relative paths this command wrote, in write order. */
  readonly written: readonly string[];
  readonly commit: string | null;
  /** Refusal findings when `ok` is false; the draft's template lint for `new` (informational). */
  readonly findings: readonly Finding[];
  /**
   * How the log was located (`ToolLog.notes`), then the caller's notes (attribution), then the
   * write's own (a shortened commit subject, …).
   */
  readonly notes: readonly string[];
}

/** What every write function takes besides its input (design §6.1). */
export interface WriteOptions {
  /** Commit the write; default `[policy] auto_commit`. */
  readonly commit?: boolean;
  /** The commit message to use instead of the `[commit] subject` one; used only when committing. */
  readonly message?: string | null;
  /** Notes to report before the write's own, such as the attribution notes. */
  readonly notes?: readonly string[];
  /**
   * With `[log] index = "committed"`: `"refresh"` (the default) keeps `<root>/index.md` fresh;
   * `"skip"` leaves it alone (the pre-commit hook's rename following, design 2b D8).
   */
  readonly index?: "refresh" | "skip";
}

export interface ProposeInput {
  readonly title: string;
  /** Default `[log] default_template`. */
  readonly template?: string;
  /** Section id → markdown. */
  readonly sections?: Readonly<Record<string, string>>;
  /** Decisions this one is meant to replace, as ids or numbers. */
  readonly supersedes?: readonly string[];
  readonly actor: Actor;
}

/** What a plan needs besides the read: a clock, randomness and templates. */
export interface PlanContext {
  /** Clock for `nextEventIdentity`. */
  readonly now: () => number;
  /** ULID and subject-id randomness. */
  readonly random?: (buf: Uint8Array) => void;
  /** Drafts' recorded template versions. */
  readonly templates: TemplateSource;
  /** Built-in template texts by name (§5.7), for `new`. */
  readonly builtins: Readonly<Record<string, string>>;
}

/** Everything one write command does, computed without touching git or the disk. */
export interface WritePlan extends LedgerWritePlan {
  readonly command: "new" | "accept" | "supersede" | "event";
  readonly subject: string;
  /** New files, repo-relative path → bytes, in write order: body, materialized template, events. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  /**
   * Existing files to replace, path → the new bytes and the bytes the plan read; written only if
   * the file still holds `expected` (a draft update).
   */
  readonly replace?: Readonly<
    Record<string, { readonly bytes: Uint8Array; readonly expected: Uint8Array }>
  >;
  readonly events: readonly EventEnvelope[];
  /** Paths to stage: every new file, plus the existing body for accept. */
  readonly stage: readonly string[];
  /** Subject ids involved (D6): the subject, every superseded target, and `by` for supersede. Sorted. */
  readonly involved: readonly string[];
  /** Per involved subject: its body, its events dir and its recorded template. Sorted, deduplicated. */
  readonly commitScope: readonly string[];
  /** The events directories in `commitScope`, sorted; the rest of `commitScope` are file paths. */
  readonly eventDirs: readonly string[];
  /** For new: the body path, the rendered bytes and the template, for the editor step. */
  readonly draft: {
    readonly path: string;
    readonly rendered: Uint8Array;
    readonly template: Template;
  } | null;
  /** What the commit message is made of; `write()` renders it with `[commit] subject`. */
  readonly commit: CommitParts | null;
  /** One `ADR`/`ADR-Event` pair per plan event, in write order. */
  readonly trailers: readonly Trailer[];
  /** Views after the write, computed on `overlayTree(read.tree, files)`. */
  readonly decision: DecisionView | null;
  readonly affected: readonly DecisionView[];
  /** Informational (new: the draft's template lint). */
  readonly findings: readonly Finding[];
  /** The write's own notes for the result (an already existing link, …). */
  readonly notes?: readonly string[];
}

/** The parts of a commit message (design §4.3): the template's variables and the body. */
export interface CommitParts {
  /** `{action}`, the verb phrase, e.g. `propose to` or `set the scope of`. */
  readonly action: string;
  /**
   * The text after `{action}`, which `{title}` and `{raw_title}` come from: the decision's title
   * as recorded for propose, accept, reject and withdraw, else its display (`ADR-0006`, or
   * `ADR-0006 with ADR-0007` for supersede).
   */
  readonly title: string;
  readonly id: string;
  readonly display: string;
  /** Body paragraphs, each wrapped at 72. */
  readonly body: readonly string[];
}

export type PlanResult =
  | { readonly ok: true; readonly plan: WritePlan }
  | {
      readonly ok: false;
      readonly decision: DecisionView | null;
      readonly findings: readonly Finding[];
    };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const compiled = compileKind(adrKind);
const SUBJECT_ATTEMPTS = 5;
const QUALIFIED_SUPERSESSION = "cross-log supersession isn't supported yet";

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const templatePath = (read: DecisionsRead, name: string) => `${read.root}/templates/${name}.md`;

/** The view of a folded decision, else `UsageError` naming why it can't be used. */
const viewOf = (read: DecisionsRead, id: string): DecisionView =>
  subjectView(read.projection, id, {
    unreadable: (id) => `decision ${id} uses a newer format; upgrade adr`,
    missing: (id) => `decision ${id} can't be read; run adr verify`,
  });

/** A refusal finding about decision `subject`, on its body (or events directory). */
const refusal = (read: DecisionsRead, rule: string, message: string, subject: string) =>
  ledgerRefusal(read, adrKind.name, rule, message, subject);

/** `"<type> is not allowed while <status>[; <status> is terminal]"`, as the fold words it. */
function illegal(type: string, status: string): string {
  const terminal = adrKind.machine.terminal.includes(status as never)
    ? `; ${status} is terminal`
    : "";
  return `${type} is not allowed while ${status}${terminal}`;
}

/** A new event of `subject`, sorting after its existing ones. */
const newEvent = (
  read: DecisionsRead,
  c: PlanContext,
  o: Parameters<typeof ledgerNewEvent>[3],
): EventEnvelope => ledgerNewEvent(read, c, adrKind, o);

/** Body, events directory and recorded template of each involved subject (D6). */
function commitScope(
  read: DecisionsRead,
  involved: readonly string[],
  extra: { readonly body?: string; readonly template?: string } = {},
): { scope: string[]; eventDirs: string[] } {
  const paths: string[] = [];
  const dirs: string[] = [];
  for (const id of involved) {
    const view = read.projection.views.get(id);
    if (view?.body_path !== null && view?.body_path !== undefined) paths.push(view.body_path);
    if (view !== undefined) paths.push(templatePath(read, view.template.name));
    dirs.push(eventDir(read.layout, id));
  }
  if (extra.body !== undefined) paths.push(extra.body);
  if (extra.template !== undefined) paths.push(extra.template);
  return { scope: sorted([...paths, ...dirs]), eventDirs: sorted(dirs) };
}

/**
 * The precheck (§6.3): folds the would-be log and gives the findings the write adds; adr refuses
 * any. Problems that were already there don't block; the write can only add findings about what
 * it touches.
 */
const precheck = (
  read: DecisionsRead,
  files: Readonly<Record<string, Uint8Array>>,
  replace: Readonly<Record<string, Uint8Array>> = {},
) =>
  ledgerPrecheck(read, files, replace, (tree) =>
    readDecisionsFrom(tree, {
      layout: read.layout,
      adr: read.adr,
      numbering: read.numbering,
      ref: read.ref,
      commit: read.commit,
      notes: read.notes,
      sources: read.sources,
    }),
  );

/**
 * Plans `adr new`: a rendered body, a materialized template if needed, and `proposed`. With
 * `refuseIncomplete` (a commit with no editor to fill the draft in, design §7.2), a draft that
 * fails the template lint is refused with those findings before any file is planned.
 */
export async function planPropose(
  read: DecisionsRead,
  input: ProposeInput,
  c: PlanContext,
  o: { readonly refuseIncomplete?: boolean } = {},
): Promise<PlanResult> {
  const title = input.title.trim();
  if (title === "" || title.length > 200 || /[\r\n]/.test(title)) {
    throw new UsageError("the title must be a single line of 1 to 200 characters");
  }
  const supersedes = sorted(
    (input.supersedes ?? []).map((s) => {
      if (s.includes(":"))
        throw new UsageError(`cannot supersede ${s.trim()}: ${QUALIFIED_SUPERSESSION}`);
      return resolveDecision(read, s);
    }),
  );
  const chosen = await chooseTemplate(
    read.tree,
    read.root,
    input.template ?? read.adr.defaultTemplate,
    c.builtins,
    adrKind.def.templates?.requireSections ?? [],
  );
  if (!chosen.ok) return { ok: false, decision: null, findings: chosen.findings };
  const t = chosen.template;
  const sections = input.sections ?? {};
  for (const [id, text] of Object.entries(sections)) {
    if (!t.sections.some((s) => s.id === id)) {
      const ids = t.sections.map((s) => s.id).join(", ");
      throw new UsageError(`template ${t.name} has no section ${id}; its sections are ${ids}`);
    }
    checkText(`section ${id}`, text);
  }
  const rendered = renderTemplate(t, { title, sections }, { missing: "guidance" });
  if (!rendered.ok) throw new UsageError(rendered.findings.map((f) => f.message).join("; "));

  let id = "";
  let bodyPath = "";
  for (let attempt = 0; ; attempt++) {
    id = newSubjectId(c.random);
    bodyPath = `${read.root}/${read.layout.bodies}/${bodyFileName(id, slugify(title))}`;
    if (!read.folded.subjects.has(id) && (await read.tree.read(bodyPath)) === null) break;
    if (attempt + 1 >= SUBJECT_ATTEMPTS) throw new FileExistsError(bodyPath);
  }
  const lint = lintDocument(t, rendered.text, { file: bodyPath, subject: id });
  if (o.refuseIncomplete === true && lint.length > 0) {
    return { ok: false, decision: null, findings: lint };
  }
  const event = newEvent(read, c, {
    subject: id,
    type: "proposed",
    data: {
      title,
      template: t.name,
      template_version: t.version,
      ...(supersedes.length === 0 ? {} : { supersedes }),
    },
    actor: input.actor,
  });
  const body = encoder.encode(rendered.text);
  const files: Record<string, Uint8Array> = { [bodyPath]: body };
  if (chosen.materialize !== null) files[chosen.path] = encoder.encode(chosen.materialize);
  Object.assign(files, eventFiles(read.layout, [event]));

  const { after, added } = await precheck(read, files);
  if (added.length > 0) return { ok: false, decision: null, findings: added };
  const { scope, eventDirs } = commitScope(read, [id], { body: bodyPath, template: chosen.path });
  return {
    ok: true,
    plan: {
      command: "new",
      subject: id,
      files,
      events: [event],
      stage: Object.keys(files),
      involved: [id],
      commitScope: scope,
      eventDirs,
      draft: { path: bodyPath, rendered: body, template: t },
      commit: { action: ACTIONS.proposed.action, title, id, display: id, body: [] },
      trailers: eventPairs([event], TRAILER_KEYS),
      decision: viewOf(after, id),
      affected: [],
      findings: lint,
    },
  };
}

/** The draft lint of an `accept`: the body against the template version its proposal recorded. */
async function acceptLint(
  read: DecisionsRead,
  view: DecisionView,
  c: PlanContext,
): Promise<{ findings: Finding[]; bytes: Uint8Array | null }> {
  const body = read.folded.subjects.get(view.id)?.loaded.body ?? null;
  if (body === null) {
    return {
      findings: [refusal(read, "body/missing", "body file is missing", view.id)],
      bytes: null,
    };
  }
  const { name, version } = view.template;
  const found = await c.templates.get(name, version);
  if (!found.ok) {
    const message =
      found.reason === "not-found"
        ? `template ${name} not found at ${found.path}`
        : `template ${name} has no version ${version} at ${found.path}`;
    return {
      findings: [refusal(read, `template/${found.reason}`, message, view.id)],
      bytes: body.bytes,
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
  } catch {
    return {
      findings: [refusal(read, "body/not-utf8", "body is not valid UTF-8", view.id)],
      bytes: body.bytes,
    };
  }
  const lint = lintDocument(found.template, text, { file: body.path, subject: view.id });
  return { findings: lint.map((f) => ({ ...f, kind: adrKind.name })), bytes: body.bytes };
}

/** Input of a draft update: the decision and the sections to replace (section id → markdown). */
export interface UpdateDraftInput {
  readonly id: string;
  readonly sections: Readonly<Record<string, string>>;
}

const MAX_SECTIONS = 50;

/**
 * Plans a draft update (design §6.6): the given sections of a proposed decision's body replaced in
 * place, every other line kept, written only if the body still holds the bytes read. Refused
 * (`ok: false`) when the decision isn't proposed or its body or template version is missing or
 * unreadable, and with `refuseIncomplete` when the new draft fails its template lint. An unknown
 * section, a missing heading or a heading in the content is a `UsageError`.
 */
export async function planUpdateDraft(
  read: DecisionsRead,
  input: UpdateDraftInput,
  c: PlanContext,
  o: { readonly refuseIncomplete?: boolean } = {},
): Promise<PlanResult> {
  const id = resolveDecision(read, input.id);
  const view = viewOf(read, id);
  const refused = (fs: readonly Finding[]): PlanResult => ({
    ok: false,
    decision: view,
    findings: fs,
  });
  if (view.status !== "proposed") {
    return refused([
      refusal(
        read,
        "decision/not-a-draft",
        `${namedView(view)} is ${view.status}; only a proposed decision's draft can change`,
        id,
      ),
    ]);
  }
  const ids = Object.keys(input.sections);
  if (ids.length === 0 || ids.length > MAX_SECTIONS) {
    throw new UsageError(`a draft update takes 1 to ${MAX_SECTIONS} sections`);
  }
  for (const [section, text] of Object.entries(input.sections))
    checkText(`section ${section}`, text);
  const { findings: problems, template, text, body } = await draftOf(read, view, c);
  if (problems.length > 0 || template === null || text === null || body === null) {
    return refused(problems);
  }
  const r = replaceSections(template, text, input.sections);
  if (!r.ok) {
    const [first] = r.findings;
    if (first?.rule === "render/unknown-section") {
      const known = template.sections.map((s) => s.id).join(", ");
      const unknown = ids.find((s) => !template.sections.some((t) => t.id === s)) ?? "";
      throw new UsageError(
        `template ${template.name} has no section ${unknown}; its sections are ${known}`,
      );
    }
    if (first?.rule === "render/section-missing") {
      const gone = new Set(extractSections(template, text).missing);
      const missing = template.sections.find((s) => ids.includes(s.id) && gone.has(s.id));
      throw new UsageError(
        `${body.path} has no '${missing?.heading ?? ""}' heading; edit the file by hand`,
      );
    }
    throw new UsageError(r.findings.map((f) => f.message).join("; "));
  }
  if (r.text === text) {
    return emptyPlan(id, view, ["the draft already has this content; nothing written"]);
  }
  const bytes = encoder.encode(r.text);
  const lint = lintDocument(template, r.text, { file: body.path, subject: id }).map((f) => ({
    ...f,
    kind: adrKind.name,
  }));
  if (o.refuseIncomplete === true && lint.length > 0) return refused(lint);
  const { after, added } = await precheck(read, {}, { [body.path]: bytes });
  if (added.length > 0) return refused(added);
  const { scope, eventDirs } = commitScope(read, [id]);
  const order = template.sections.map((s) => s.id).filter((s) => ids.includes(s));
  return {
    ok: true,
    plan: {
      command: "event",
      subject: id,
      files: {},
      replace: { [body.path]: { bytes, expected: body.bytes } },
      events: [],
      stage: [body.path],
      involved: [id],
      commitScope: scope,
      eventDirs,
      draft: null,
      commit: {
        action: DRAFT_ACTION,
        title: view.display,
        id,
        display: view.display,
        body: [`Sections: ${order.join(", ")}.`],
      },
      trailers: [["ADR", id]],
      decision: after.projection.views.get(id) ?? view,
      affected: [],
      findings: lint,
    },
  };
}

/**
 * A proposed decision's body, its text and the template version its proposal recorded, or the
 * refusal findings when one of them is missing or the body isn't UTF-8.
 */
async function draftOf(
  read: DecisionsRead,
  view: DecisionView,
  c: PlanContext,
): Promise<{
  findings: Finding[];
  template: Template | null;
  text: string | null;
  body: { readonly path: string; readonly bytes: Uint8Array } | null;
}> {
  const none = { template: null, text: null, body: null };
  const body = read.folded.subjects.get(view.id)?.loaded.body ?? null;
  if (body === null) {
    return { findings: [refusal(read, "body/missing", "body file is missing", view.id)], ...none };
  }
  const { name, version } = view.template;
  const found = await c.templates.get(name, version);
  if (!found.ok) {
    const message =
      found.reason === "not-found"
        ? `template ${name} not found at ${found.path}`
        : `template ${name} has no version ${version} at ${found.path}`;
    return { findings: [refusal(read, `template/${found.reason}`, message, view.id)], ...none };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
    return { findings: [], template: found.template, text, body };
  } catch {
    return {
      findings: [refusal(read, "body/not-utf8", "body is not valid UTF-8", view.id)],
      ...none,
    };
  }
}

/** Plans `adr accept`: `accepted` with the body hash, and `superseded` on each declared target. */
export async function planAccept(
  read: DecisionsRead,
  input: { readonly id: string; readonly actor: Actor },
  c: PlanContext,
  o: { readonly copyGlobs?: readonly string[]; readonly tracked?: readonly string[] } = {},
): Promise<PlanResult> {
  const id = resolveDecision(read, input.id);
  const view = viewOf(read, id);
  const refused = (findings: readonly Finding[]): PlanResult => ({
    ok: false,
    decision: view,
    findings,
  });
  const findings: Finding[] = [];
  if (view.status !== "proposed") {
    findings.push(refusal(read, "transition/illegal", illegal("accepted", view.status), id));
  }
  const lint = await acceptLint(read, view, c);
  findings.push(...lint.findings);
  if (read.adr.acceptRequiresHuman && input.actor.kind === "agent") {
    findings.push(
      refusal(
        read,
        "decision/agent-accepted",
        `accepted by agent ${input.actor.name}; accept_requires_human needs a human`,
        id,
      ),
    );
  }
  const targets: string[] = [];
  for (const target of view.declared_supersedes) {
    if (target.includes(":")) {
      findings.push(
        refusal(
          read,
          "decision/reference-missing",
          `supersedes ${target}: ${QUALIFIED_SUPERSESSION}`,
          id,
        ),
      );
      continue;
    }
    const t = read.projection.views.get(target);
    if (t === undefined) {
      findings.push(
        refusal(
          read,
          "decision/reference-missing",
          `supersedes ${target}, which is not in the log`,
          id,
        ),
      );
    } else if (target === id) {
      findings.push(
        refusal(read, "decision/supersession-cycle", `supersession cycle: ${id} → ${id}`, id),
      );
    } else if (t.status !== "accepted" && t.status !== "deprecated") {
      findings.push(refusal(read, "transition/illegal", illegal("superseded", t.status), target));
    } else {
      targets.push(target);
    }
  }
  if (findings.length > 0 || lint.bytes === null) return refused(findings);

  const accepted = newEvent(read, c, {
    subject: id,
    type: "accepted",
    data: { body_sha256: bodySha256(lint.bytes) },
    actor: input.actor,
  });
  const cascade = targets.map((target) =>
    newEvent(read, c, {
      subject: target,
      type: "superseded",
      data: { by: id },
      actor: input.actor,
    }),
  );
  // Copying the superseded scope (design §6.10): one `scoped` event with the union, in the same
  // batch. `scoped` is allowed while proposed and accepted, so its order against `accepted`
  // doesn't change the fold.
  const copyGlobs = o.copyGlobs ?? [];
  const copied =
    copyGlobs.length === 0
      ? null
      : newEvent(read, c, {
          subject: id,
          type: "scoped",
          data: {
            set: [
              ...applySetOp(view.applies_to, { add: copyGlobs }, { what: "glob", maxItems: 200 })
                .set,
            ],
          },
          actor: input.actor,
          after: [accepted],
        });
  if (copied !== null) {
    const valid = compiled.validate(copied, { file: null });
    if (!valid.ok) {
      return refused(valid.findings.map((f) => ({ ...f, subject: id, kind: adrKind.name })));
    }
  }
  const sources = copied === null ? [] : scopeToCopy(read, id).sources;
  const events = [accepted, ...(copied === null ? [] : [copied]), ...cascade];
  const files = eventFiles(read.layout, events);
  const { after, added } = await precheck(read, files);
  if (added.length > 0) return refused(added);
  const involved = sorted([id, ...targets]);
  const { scope, eventDirs } = commitScope(read, involved);
  const bodyPath = view.body_path ?? "";
  // Accepted, the decision's globs must match (?7): say so for each one that doesn't yet.
  const globs = copied === null ? view.applies_to : (copied.data.set as readonly string[]);
  const unmatched = o.tracked === undefined ? [] : unmatchedGlobs(globs, o.tracked);
  return {
    ok: true,
    plan: {
      ...(unmatched.length === 0
        ? {}
        : {
            notes: unmatched.map(
              (g) =>
                `${g} matches no tracked file; from this commit verify reports scope/glob-unmatched until a file matches, so commit the files with it or change the scope`,
            ),
          }),
      command: "accept",
      subject: id,
      files,
      events,
      stage: [...Object.keys(files), bodyPath],
      involved,
      commitScope: scope,
      eventDirs,
      draft: null,
      commit: {
        action: ACTIONS.accepted.action,
        title: view.title,
        id,
        display: view.display,
        body: [
          ...targets.map((t) => {
            const v = viewOf(read, t);
            return `Supersedes ${v.display}: ${sentenceTitle(v.title)}.`;
          }),
          ...sources.map((t) => `Copies the scope of ${viewOf(read, t).display}.`),
        ],
      },
      trailers: eventPairs(events, TRAILER_KEYS),
      decision: viewOf(after, id),
      affected: targets.map((t) => viewOf(after, t)),
      findings: [],
    },
  };
}

/** The scope an `accept` can copy from the decisions it supersedes (design §6.10). */
export interface ScopeOffer {
  /** The decision being accepted. */
  readonly id: string;
  /** The superseded decisions with globs the accepted one lacks, sorted by id. */
  readonly sources: readonly string[];
  /** Their displays (`ADR-0002`, or the id), in `sources` order. */
  readonly displays: readonly string[];
  /** The globs to add: the union of their scopes minus the accepted decision's own, sorted. */
  readonly globs: readonly string[];
}

/**
 * Whether `accept` copies the superseded decisions' scope: always, never, never but with a note
 * naming the `adr scope` command that would (the default), or as a function decides.
 */
export type CopyScope = "copy" | "skip" | "suggest" | ((offer: ScopeOffer) => Promise<boolean>);

/**
 * What accepting `id` could copy: the declared targets it will supersede (accepted or
 * deprecated, as `planAccept` selects them) and the globs of theirs it doesn't have yet.
 */
export function scopeToCopy(read: DecisionsRead, id: string): ScopeOffer {
  const own = new Set(viewOf(read, id).applies_to);
  const sources: string[] = [];
  const globs = new Set<string>();
  for (const target of sorted(viewOf(read, id).declared_supersedes)) {
    const t = target === id ? undefined : read.projection.views.get(target);
    if (t === undefined || (t.status !== "accepted" && t.status !== "deprecated")) continue;
    const extra = t.applies_to.filter((g) => !own.has(g));
    if (extra.length === 0) continue;
    sources.push(target);
    for (const g of extra) globs.add(g);
  }
  return {
    id,
    sources,
    displays: sources.map((t) => viewOf(read, t).display),
    globs: sorted(globs),
  };
}

const shQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const andList = (xs: readonly string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** The note of an offer not taken: the `adr scope` command that copies it. */
function copyScopeNote(id: string, offer: ScopeOffer): string {
  const n = offer.globs.length;
  const adds = offer.globs.map((g) => `--add ${shQuote(g)}`).join(" ");
  return `not copying the scope of ${andList(offer.displays)} (${n} ${n === 1 ? "glob" : "globs"}); to copy it: adr scope ${id} ${adds}`;
}

/** Plans `adr supersede <id> --by <by>`: one `superseded` event on `id`. */
export async function planSupersede(
  read: DecisionsRead,
  input: {
    readonly id: string;
    readonly by: string;
    readonly reason?: string | null;
    readonly actor: Actor;
  },
  c: PlanContext,
): Promise<PlanResult> {
  if (input.by.includes(":")) {
    throw new UsageError(`--by ${input.by.trim()}: ${QUALIFIED_SUPERSESSION}`);
  }
  const reason = checkReason(input.reason);
  const id = resolveDecision(read, input.id);
  const by = resolveDecision(read, input.by);
  const view = viewOf(read, id);
  const target = viewOf(read, by);
  const findings: Finding[] = [];
  if (view.status !== "accepted" && view.status !== "deprecated") {
    findings.push(refusal(read, "transition/illegal", illegal("superseded", view.status), id));
  }
  if (by === id || target.chain.includes(id)) {
    const cycle =
      by === id ? [id, id] : [id, ...target.chain.slice(0, target.chain.indexOf(id) + 1)];
    findings.push(
      refusal(read, "decision/supersession-cycle", `supersession cycle: ${cycle.join(" → ")}`, id),
    );
  } else if (target.status !== "accepted") {
    findings.push(
      refusal(
        read,
        "decision/superseded-by-unaccepted",
        `superseded by ${by}, which is not accepted`,
        id,
      ),
    );
  }
  const refused = (fs: readonly Finding[]): PlanResult => ({
    ok: false,
    decision: view,
    findings: fs,
  });
  if (findings.length > 0) return refused(findings);

  const event = newEvent(read, c, {
    subject: id,
    type: "superseded",
    data: { by },
    reason,
    actor: input.actor,
  });
  const files = eventFiles(read.layout, [event]);
  const { after, added } = await precheck(read, files);
  if (added.length > 0) return refused(added);
  const involved = sorted([id, by]);
  const { scope, eventDirs } = commitScope(read, involved);
  return {
    ok: true,
    plan: {
      command: "supersede",
      subject: id,
      files,
      events: [event],
      stage: Object.keys(files),
      involved,
      commitScope: scope,
      eventDirs,
      draft: null,
      commit: {
        action: ACTIONS.superseded.action,
        title: `${view.display} with ${target.display}`,
        id,
        display: view.display,
        body: [`Superseded by ${target.display}: ${sentenceTitle(target.title)}.`],
      },
      trailers: eventPairs([event], TRAILER_KEYS),
      decision: viewOf(after, id),
      affected: [viewOf(after, id)],
      findings: [],
    },
  };
}

const actionOf = (type: string): { action: string; names: "title" | "display" } =>
  Object.hasOwn(ACTIONS, type)
    ? ACTIONS[type as keyof typeof ACTIONS]
    : { action: type, names: "display" };

/** A title in a body sentence: whitespace collapsed and trailing dots removed, as in a subject. */
const sentenceTitle = (title: string) =>
  title
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim();

/**
 * Plans any one event on an existing decision: the state machine and the event's validation
 * decide, then the precheck. Phase 2's reject, withdraw, deprecate, note, link and scope wrap it.
 */
export async function planEvent(
  read: DecisionsRead,
  input: {
    readonly subject: string;
    readonly type: string;
    readonly data: Record<string, unknown>;
    readonly reason?: string | null;
    readonly actor: Actor;
  },
  c: PlanContext,
): Promise<PlanResult> {
  const id = resolveDecision(read, input.subject);
  const view = viewOf(read, id);
  if (!adrKind.machine.types.has(input.type) || input.type === adrKind.machine.initial.type) {
    throw new InvalidArgumentError(`planEvent can't write a ${input.type} event`);
  }
  const reason = checkReason(input.reason);
  const refused = (fs: readonly Finding[]): PlanResult => ({
    ok: false,
    decision: view,
    findings: fs,
  });
  if (!adrKind.machine.allowed(view.status, input.type)) {
    return refused([refusal(read, "transition/illegal", illegal(input.type, view.status), id)]);
  }
  const event = newEvent(read, c, {
    subject: id,
    type: input.type,
    data: input.data,
    reason,
    actor: input.actor,
  });
  const valid = compiled.validate(event, { file: null });
  if (!valid.ok) {
    return refused(valid.findings.map((f) => ({ ...f, subject: id, kind: adrKind.name })));
  }
  const files = eventFiles(read.layout, [event]);
  const { after, added } = await precheck(read, files);
  if (added.length > 0) return refused(added);
  const by = input.type === "superseded" ? String(input.data.by) : null;
  const involved = sorted([id, ...(by !== null && isSubjectId(by) ? [by] : [])]);
  const { scope, eventDirs } = commitScope(read, involved);
  return {
    ok: true,
    plan: {
      command: "event",
      subject: id,
      files,
      events: [event],
      stage: Object.keys(files),
      involved,
      commitScope: scope,
      eventDirs,
      draft: null,
      commit: {
        action: actionOf(input.type).action,
        title: actionOf(input.type).names === "title" ? view.title : view.display,
        id,
        display: view.display,
        body: reason === null ? [] : [`Reason: ${reason}`],
      },
      trailers: eventPairs([event], TRAILER_KEYS),
      decision: viewOf(after, id),
      affected: input.type === "superseded" ? [viewOf(after, id)] : [],
      findings: [],
    },
  };
}

/** Input of the lifecycle exits: the decision and the envelope's `reason`. */
export interface ReasonInput {
  readonly id: string;
  readonly reason?: string | null;
  readonly actor: Actor;
}

/** Plans `adr reject`: `rejected` with its required reason, while proposed. */
export function planReject(read: DecisionsRead, input: ReasonInput, c: PlanContext) {
  return planEvent(read, { ...input, subject: input.id, type: "rejected", data: {} }, c);
}

/** Plans `adr withdraw`: `withdrawn`, with a reason when given, while proposed. */
export function planWithdraw(read: DecisionsRead, input: ReasonInput, c: PlanContext) {
  return planEvent(read, { ...input, subject: input.id, type: "withdrawn", data: {} }, c);
}

/** Plans `adr deprecate`: `deprecated` with its required reason, while accepted. */
export function planDeprecate(read: DecisionsRead, input: ReasonInput, c: PlanContext) {
  return planEvent(read, { ...input, subject: input.id, type: "deprecated", data: {} }, c);
}

/** Plans `adr note`: `noted` with the text as given, in every state. */
export function planNote(
  read: DecisionsRead,
  input: { readonly id: string; readonly text: string; readonly actor: Actor },
  c: PlanContext,
): Promise<PlanResult> {
  if (input.text.trim() === "") throw new UsageError("the note text must not be empty");
  checkText("the note text", input.text);
  return planEvent(
    read,
    { subject: input.id, type: "noted", data: { text: input.text }, actor: input.actor },
    c,
  );
}

const LINK_RELS: readonly LinkRel[] = ["relates-to", "refines", "depends-on"];

export interface LinkInput {
  readonly id: string;
  /** A local id or number, or `<source>:<id>` naming a configured `[[sources]]` entry. */
  readonly to: string;
  /** Default `relates-to`. */
  readonly rel?: string;
  readonly actor: Actor;
}

/**
 * Plans `adr link` (design §6.7): `linked` in every state. A qualified target must name one of
 * `o.sources` (the log's `[[sources]]` names) of kind `adr` (`o.logs`, from the local cache): a
 * cached source must hold the id, else `UsageError`; into an uncached one the link is written with
 * a note that it isn't checked. A link that already exists plans nothing, with a note.
 */
export async function planLink(
  read: DecisionsRead,
  input: LinkInput,
  c: PlanContext,
  o: {
    readonly sources?: readonly string[];
    readonly logs?: ReadonlyMap<string, AdrSource>;
    readonly kinds?: ReadonlyMap<string, string>;
  } = {},
): Promise<PlanResult> {
  const rel = input.rel ?? "relates-to";
  if (!(LINK_RELS as readonly string[]).includes(rel)) {
    throw new UsageError(`unknown --rel ${rel}; use relates-to, refines or depends-on`);
  }
  const id = resolveDecision(read, input.id);
  const view = viewOf(read, id);
  const target = input.to.trim();
  let to: string;
  let shown: string;
  let described: string;
  let named: string;
  let foreignNote: string | null = null;
  const at = target.indexOf(":");
  if (at >= 0) {
    const source = target.slice(0, at);
    const local = target.slice(at + 1);
    if (!isSourceName(source) || !isSubjectId(local)) {
      throw new UsageError(`invalid decision ${JSON.stringify(input.to)}`);
    }
    if (!(o.sources ?? []).includes(source)) {
      throw new UsageError(`unknown source ${source}; add a [[sources]] entry named ${source}`);
    }
    const kind = o.kinds?.get(source);
    if (kind !== undefined && kind !== "adr") {
      throw new UsageError(`source ${source} has kind ${kind}, which adr doesn't read`);
    }
    const cached = o.logs?.get(source);
    if (cached?.subjects !== null && cached?.subjects !== undefined) {
      if (!cached.subjects.has(local)) {
        throw new UsageError(
          `${target} is not in source ${source} (pinned at ${(cached.commit ?? "").slice(0, 12)})`,
        );
      }
    } else if (o.logs !== undefined) {
      foreignNote = `${source} not fetched; the reference isn't checked`;
    }
    to = target;
    shown = target;
    described = `${rel} ${target}.`;
    named = `${view.display} ${CROSS_LOG_LINK}`;
  } else {
    to = resolveDecision(read, target);
    if (to === id) throw new UsageError("a decision can't link to itself");
    const t = viewOf(read, to);
    shown = t.display;
    described = `${rel} ${t.display}: ${sentenceTitle(t.title)}.`;
    named = `${view.display} to ${t.display}`;
  }
  if (view.links.some((l) => l.to === to && l.rel === rel)) {
    return {
      ok: true,
      plan: {
        command: "event",
        subject: id,
        files: {},
        events: [],
        stage: [],
        involved: [id],
        commitScope: [],
        eventDirs: [],
        draft: null,
        commit: null,
        trailers: [],
        decision: view,
        affected: [],
        findings: [],
        notes: [`already linked: ${view.display} ${rel} ${shown}; nothing written`],
      },
    };
  }
  const r = await planEvent(
    read,
    { subject: id, type: "linked", data: { to, rel }, actor: input.actor },
    c,
  );
  if (!r.ok || r.plan.commit === null) return r;
  return {
    ok: true,
    plan: {
      ...r.plan,
      commit: { ...r.plan.commit, title: named, body: [described] },
      notes: [...(r.plan.notes ?? []), ...(foreignNote === null ? [] : [foreignNote])],
    },
  };
}

export interface ScopeInput {
  readonly id: string;
  /** Replace (`set`, `[]` clears), or `add` and `remove` globs (design §3.2). */
  readonly op: SetOp;
  readonly actor: Actor;
  /** How the caller names `set`, `add`, `remove` and `clear` in messages; default the field names. */
  readonly names?: {
    readonly set: string;
    readonly add: string;
    readonly remove: string;
    readonly clear?: string;
  };
}

/** `ADR-0003 (k3f9q8a1)`, or the id alone when the decision has no number. */
const namedView = (v: DecisionView) => (v.display === v.id ? v.id : `${v.display} (${v.id})`);

/**
 * Plans `adr scope` with a set operation (design §6.8): one `scoped` event with the whole new set
 * while proposed, accepted or deprecated, or nothing when the set doesn't change. Invalid globs,
 * conflicting operations and more than 200 globs are `UsageError`s. Notes name removed globs that
 * weren't there, added ones that were, resulting globs matching none of `o.tracked` (when given)
 * and a narrowed accepted scope.
 */
export async function planScope(
  read: DecisionsRead,
  input: ScopeInput,
  c: PlanContext,
  o: { readonly tracked?: readonly string[] } = {},
): Promise<PlanResult> {
  const id = resolveDecision(read, input.id);
  const view = viewOf(read, id);
  const result = applySetOp(view.applies_to, input.op, {
    what: "glob",
    validate: (g) => {
      const parsed = parseGlob(g);
      return parsed.ok ? null : parsed.message;
    },
    maxItems: 200,
    ...(input.names === undefined ? {} : { names: input.names }),
  });
  if (!adrKind.machine.allowed(view.status, "scoped")) {
    return {
      ok: false,
      decision: view,
      findings: [refusal(read, "transition/illegal", illegal("scoped", view.status), id)],
    };
  }
  const named = namedView(view);
  const notes = [
    ...result.absent.map((g) => `${g} is not in the scope of ${named}`),
    ...result.present.map((g) => `${g} is already in the scope of ${named}`),
  ];
  if (!result.changed) {
    return {
      ok: true,
      plan: {
        command: "event",
        subject: id,
        files: {},
        events: [],
        stage: [],
        involved: [id],
        commitScope: [],
        eventDirs: [],
        draft: null,
        commit: null,
        trailers: [],
        decision: view,
        affected: [],
        findings: [],
        notes,
      },
    };
  }
  if (o.tracked !== undefined) {
    // Verify's scope/glob-unmatched applies to the statuses in requireMatchIn (?7): accepted
    // decisions; a proposed one may name code that doesn't exist yet.
    const checked = (adrKind.def.scope?.requireMatchIn ?? []).includes(view.status)
      ? "; verify (hooks and CI) reports scope/glob-unmatched until a file matches"
      : view.status === "proposed"
        ? `; verify reports scope/glob-unmatched once ${view.display} is accepted, until a file matches`
        : "";
    notes.push(
      ...unmatchedGlobs(result.set, o.tracked).map((g) => `${g} matches no tracked file${checked}`),
    );
  }
  if (result.removed.length > 0 && (view.status === "accepted" || view.status === "deprecated")) {
    notes.push(
      "this narrows the scope of an accepted decision; if its Scope section no longer reads true, propose a superseding decision instead",
    );
  }
  const r = await planEvent(
    read,
    { subject: id, type: "scoped", data: { set: [...result.set] }, actor: input.actor },
    c,
  );
  return r.ok ? { ok: true, plan: { ...r.plan, notes } } : r;
}

/**
 * Plans one `scoped` event per change, in one batch (design §6.8 step 4): each decision's status
 * must allow `scoped` and each event must validate, else the first failing decision is refused.
 * The plan has no commit message, because `--follow-renames` never commits. `decision` is
 * `input.id`'s view after the write, or `null` without one; `affected` are the changed views.
 */
async function planScopeEvents(
  read: DecisionsRead,
  changes: readonly { readonly id: string; readonly set: readonly string[] }[],
  input: { readonly id: string | null; readonly actor: Actor },
  c: PlanContext,
): Promise<PlanResult> {
  const given = input.id === null ? null : viewOf(read, input.id);
  const events: EventEnvelope[] = [];
  for (const change of changes) {
    const view = viewOf(read, change.id);
    const refused = (findings: readonly Finding[]): PlanResult => ({
      ok: false,
      decision: given,
      findings,
    });
    if (!adrKind.machine.allowed(view.status, "scoped")) {
      return refused([
        refusal(read, "transition/illegal", illegal("scoped", view.status), change.id),
      ]);
    }
    const event = newEvent(read, c, {
      subject: change.id,
      type: "scoped",
      data: { set: [...change.set] },
      actor: input.actor,
    });
    const valid = compiled.validate(event, { file: null });
    if (!valid.ok) {
      return refused(valid.findings.map((f) => ({ ...f, subject: change.id, kind: adrKind.name })));
    }
    events.push(event);
  }
  const files = eventFiles(read.layout, events);
  const { after, added } = await precheck(read, files);
  if (added.length > 0) return { ok: false, decision: given, findings: added };
  const involved = sorted(changes.map((ch) => ch.id));
  const { scope, eventDirs } = commitScope(read, involved);
  return {
    ok: true,
    plan: {
      command: "event",
      subject: input.id ?? involved[0] ?? "",
      files,
      events,
      stage: Object.keys(files),
      involved,
      commitScope: scope,
      eventDirs,
      draft: null,
      commit: null,
      trailers: eventPairs(events, TRAILER_KEYS),
      decision: input.id === null ? null : viewOf(after, input.id),
      affected: changes.map((ch) => viewOf(after, ch.id)),
      findings: [],
    },
  };
}

/** A plan that writes nothing: the views as they are, and `notes`. */
function emptyPlan(
  subject: string,
  decision: DecisionView | null,
  notes: readonly string[],
): PlanResult {
  return {
    ok: true,
    plan: {
      command: "event",
      subject,
      files: {},
      events: [],
      stage: [],
      involved: decision === null ? [] : [decision.id],
      commitScope: [],
      eventDirs: [],
      draft: null,
      commit: null,
      trailers: [],
      decision,
      affected: [],
      findings: [],
      notes,
    },
  };
}

/**
 * Plans `adr scope [<decision>] --follow-renames` (design §6.8 steps 1–4): the given decision's
 * globs, or every decision's, rewritten by `followRenames`. Decisions whose status forbids
 * `scoped` are skipped, with a note when the renames would have changed their scope; an explicit
 * one is refused.
 */
async function planFollowRenames(
  read: DecisionsRead,
  input: { readonly id: string | null; readonly actor: Actor },
  staged: StagedRenames,
  c: PlanContext,
): Promise<PlanResult> {
  const id = input.id === null ? null : resolveDecision(read, input.id);
  const given = id === null ? null : viewOf(read, id);
  if (staged.renames.length === 0) return emptyPlan(id ?? "", given, []);
  if (given !== null && !adrKind.machine.allowed(given.status, "scoped")) {
    return {
      ok: false,
      decision: given,
      findings: [refusal(read, "transition/illegal", illegal("scoped", given.status), given.id)],
    };
  }
  const views = given !== null ? [given] : [...read.projection.views.values()];
  const followed = followRenamesChanges(views, staged, {
    named: namedView,
    blocked: (view, leaving) =>
      adrKind.machine.allowed(view.status, "scoped")
        ? null
        : `${namedView(view)} is ${view.status}; its scope can't follow renames (${leaving} renamed files leave it)`,
    change: (view, globs) => ({ change: { id: view.id, set: globs } }),
  });
  if (!followed.ok) return followed.stop;
  const { changes, notes } = followed;
  if (changes.length === 0) return emptyPlan(id ?? "", given, notes);
  const r = await planScopeEvents(read, changes, { id, actor: input.actor }, c);
  return r.ok ? { ok: true, plan: { ...r.plan, notes } } : r;
}

/** The paths of every file in `tree`. */
async function filePaths(tree: TreeReader): Promise<string[]> {
  return (await tree.list("")).filter((e) => e.type === "file").map((e) => e.path);
}

/** Every tracked file in the index, for the "matches no tracked file" notes. */
async function trackedFiles(log: DecisionLog): Promise<string[]> {
  return filePaths(await indexReader(log.git));
}

/**
 * Applies a plan (§5.4) with ledger's `applyPlan` and adr's bindings: the `ADR`/`ADR-Event`
 * trailers, the plan's own commit scope, and after the editor step an index rendered again from
 * the plan's bytes only when the staged events changed (design 2b §4.5).
 */
export function applyPlan(
  log: DecisionLog,
  plan: WritePlan,
  o: {
    readonly commit: boolean;
    /** The commit message, without trailers; required when committing. */
    readonly message?: string;
    /** `message` is the user's own: append the trailers to its own trailer block, if it ends in one. */
    readonly mergeTrailers?: boolean;
    /**
     * Renders the commit message once the extra staged events are known (?6), instead of
     * `message`: `plan` holds the plan's own events, `extra` the other staged event files the
     * commit sweeps in (by file name, deduplicated by subject and type), and `tree` is the
     * commit's tree. Exclusive with `message`.
     */
    readonly compose?: (c: ComposeInput) => RenderedCommit;
    readonly afterStage?: () => Promise<AfterStage>;
    /**
     * Renders the log's index for `tree`, which builds on `history` (HEAD, the new commit, or
     * null on an unborn HEAD); `null` when the numbers can't be projected. Given only when the log
     * keeps a committed index (design 2b D2, §4.5).
     */
    readonly index?: IndexRender;
  },
): Promise<AppliedPlan> {
  return ledgerApplyPlan(log, plan, {
    ...o,
    trailerKeys: TRAILER_KEYS,
    tool: "adr",
    noun: "decision",
    plural: "decisions",
    rerenderAfterEdit: "when-events-change",
    afterEditBytes: "plan",
  });
}

/** The `ADR`/`ADR-Event` trailer keys. */
const TRAILER_KEYS = { subject: "ADR", event: "ADR-Event" } as const;

/**
 * The clock, the randomness and `applyPlan` the write functions use. Only tests pass their own
 * (for example an `apply` that fails once); the default is the real ones.
 */
export interface WriteDeps {
  readonly now: () => number;
  readonly random?: (buf: Uint8Array) => void;
  readonly apply: typeof applyPlan;
}
const DEFAULT_DEPS: WriteDeps = { now: Date.now, apply: applyPlan };

/**
 * The views `adr-write/v1` reports. Without a commit they are the plan's, folded on the overlay.
 * After a commit they come from a new read of the log, so a commit on the main ref shows the
 * numbers it assigned, as the CLI text and phase 3's MCP tools do. A commit that failed threw in
 * `applyPlan`, so nothing is read for it.
 */
async function viewsAfter(
  log: DecisionLog,
  plan: WritePlan,
  sha: string | null,
): Promise<{ decision: DecisionView | null; affected: readonly DecisionView[] }> {
  if (sha === null) return { decision: plan.decision, affected: plan.affected };
  const read = await readDecisions({ ...log, commit: sha });
  const view = (v: DecisionView) => read.projection.views.get(v.id) ?? v;
  return {
    decision: plan.decision === null ? null : view(plan.decision),
    affected: plan.affected.map(view),
  };
}

/**
 * `--commit` needs an author and a committer identity; checked before anything is written, since
 * `GIT_AUTHOR_*` alone satisfies the author while `git commit` still fails on the committer.
 */
async function checkCommitIdentity(log: DecisionLog): Promise<void> {
  if ((await log.git.identity()) === null || (await log.git.committerIdentity()) === null) {
    throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
  }
}

const STATUS_TYPES: ReadonlySet<string> = new Set([
  "proposed",
  "accepted",
  "rejected",
  "withdrawn",
]);

/**
 * The commit's action and title slot (ADR-0008, ?6), chosen once the staged events the commit
 * sweeps in are known: when `plan` or `extra` holds a status event (proposed, accepted, rejected,
 * withdrawn), the title form of the last one, since that is what the commit decides. Otherwise
 * the plan's own subject when the extra events add no other verb; with two or three verbs those
 * joined (`link and scope ADR-0003`), and beyond three (or where the joined verbs don't fit a
 * custom template) `update ADR-0003`. Every single-action subject stays the plan's own, byte for
 * byte.
 */
export function composeSubject(
  read: DecisionsRead,
  parts: CommitParts,
  c: { readonly plan: readonly EventRef[]; readonly extra: readonly EventRef[] },
): { readonly action: string; readonly title: string } {
  const all = [...c.extra, ...c.plan];
  const status = all.filter((e) => STATUS_TYPES.has(e.type)).at(-1);
  if (status !== undefined) {
    const own = c.plan.some((e) => e.subject === status.subject && e.type === status.type);
    if (own) return { action: parts.action, title: parts.title };
    const action = ACTIONS[status.type as keyof typeof ACTIONS].action;
    return { action, title: read.projection.views.get(status.subject)?.title ?? status.subject };
  }
  const primary = c.plan[0]?.type;
  const verbs = new Set<string>();
  for (const t of [primary, ...c.extra.map((e) => e.type)]) {
    if (t !== undefined && Object.hasOwn(BATCH_ACTIONS, t)) verbs.add(t);
  }
  if (verbs.size <= 1 || primary === undefined || !verbs.has(primary)) {
    return { action: parts.action, title: parts.title };
  }
  const ordered = BATCH_ORDER.filter((t) => verbs.has(t)).map(
    (t) => BATCH_ACTIONS[t as keyof typeof BATCH_ACTIONS],
  );
  return {
    action: ordered.length > 3 ? UPDATE_ACTION : joinActions(ordered),
    title: parts.display,
  };
}

/** The plan's commit message from `[commit] subject` (design §4), with `composeSubject`'s slot. */
function commitMessage(
  log: DecisionLog,
  command: string,
  read: DecisionsRead,
  plan: WritePlan,
  c: { readonly plan: readonly EventRef[]; readonly extra: readonly EventRef[] },
): RenderedCommit {
  const parts = plan.commit;
  if (parts === null) throw new InvalidArgumentError("this write can't be committed");
  const { action, title } = composeSubject(read, parts, c);
  const render = (a: string) =>
    renderCommitMessage(log.adr.commitSubject, {
      title,
      vars: { action: a, id: parts.id, display: parts.display, command },
      body: parts.body,
    });
  const r = render(action);
  // A batch names the display, which is never shortened: a custom template too long for the
  // joined verbs gets `update <display>`.
  return r.shortened && title === parts.display && action !== parts.action
    ? render(UPDATE_ACTION)
    : r;
}

/**
 * Plan, then apply, with the single `EventExistsError` retry (§5.4 steps 1–5). `o.message`
 * replaces the rendered commit message; `o.notes` come before the write's own notes. A plan with
 * no files and no events is reported as written without touching the repository, and so is
 * every plan with `dryRun` (its views are the plan's).
 */
async function write(
  log: DecisionLog,
  command: WriteResultJson["command"],
  plan: (read: DecisionsRead, c: PlanContext) => Promise<PlanResult>,
  o: WriteOptions & { readonly dryRun?: boolean },
  deps: WriteDeps,
  afterStage?: (plan: WritePlan, commit: boolean) => () => Promise<AfterStage>,
): Promise<WriteResultJson> {
  return withGitOperation(async () => {
    if (log.ref !== null) {
      throw new InvalidArgumentError("writes read the work tree; open the log without a ref");
    }
    if (log.tree.label !== "worktree") {
      throw new InvalidArgumentError(
        "writes read the work tree; open the log with the worktree reader",
      );
    }
    const commit = o.commit ?? log.adr.autoCommit;
    if (commit) await checkCommitIdentity(log);
    const notes = [...log.notes, ...(o.notes ?? [])];
    for (let attempt = 0; ; attempt++) {
      const read = await readDecisions(log);
      const ref = await templateHistoryRef(log.git, { type: "full" });
      const c: PlanContext = {
        now: deps.now,
        ...(deps.random === undefined ? {} : { random: deps.random }),
        templates: historyTemplates(log.git, log.tree, `${read.root}/templates`, { ref }),
        builtins: BUILTIN_TEMPLATES,
      };
      const r = await plan(read, c);
      if (!r.ok) {
        return {
          format: "adr-write/v1",
          command,
          ok: false,
          decision: r.decision,
          affected: [],
          written: [],
          commit: null,
          findings: r.findings,
          notes,
        };
      }
      const empty =
        r.plan.events.length === 0 &&
        Object.keys(r.plan.files).length === 0 &&
        Object.keys(r.plan.replace ?? {}).length === 0;
      if (empty || o.dryRun === true) {
        return {
          format: "adr-write/v1",
          command,
          ok: true,
          decision: r.plan.decision,
          affected: r.plan.affected,
          written: [],
          commit: null,
          findings: r.plan.findings,
          notes: [...notes, ...(r.plan.notes ?? [])],
        };
      }
      if (commit && r.plan.commit === null) {
        throw new InvalidArgumentError("this write can't be committed");
      }
      const given = o.message ?? null;
      try {
        const applied = await deps.apply(log, r.plan, {
          commit,
          ...(!commit
            ? {}
            : given !== null
              ? { message: given, mergeTrailers: true }
              : { compose: (c) => commitMessage(log, command, read, r.plan, c) }),
          ...(afterStage === undefined ? {} : { afterStage: afterStage(r.plan, commit) }),
          ...(log.adr.index === "committed" && o.index !== "skip"
            ? {
                index: (tree: TreeReader, history: string | null) =>
                  renderDecisionIndex(log.git, { layout: log.layout, adr: log.adr, tree, history }),
              }
            : {}),
        });
        const views = await viewsAfter(log, r.plan, applied.commit);
        const own = [
          ...(r.plan.notes ?? []),
          ...applied.notes,
          ...(applied.commit !== null && applied.rendered?.note != null
            ? [applied.rendered.note]
            : []),
        ];
        return {
          format: "adr-write/v1",
          command,
          ok: true,
          decision: views.decision,
          affected: views.affected,
          written: applied.written,
          commit: applied.commit,
          findings: applied.findings,
          notes: [...notes, ...own],
        };
      } catch (err) {
        // A refused commit keeps the notes a successful write would report, before applyPlan's.
        if (err instanceof CommitFailedError)
          throw err.withNotes([...notes, ...(r.plan.notes ?? [])]);
        // Another process wrote the same event path in the same instant: writeEvents removed this
        // batch and applyPlan the new body and template, so plan again with a fresh clock, once.
        if (!(err instanceof EventExistsError) || attempt > 0) throw err;
      }
    }
  });
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The editor step (§5.4): runs `edit` on the staged draft, re-stages the edited body when the
 * editor exited 0, and skips the commit when committing would take content nobody confirmed: the
 * body changed while the editor failed, the body is gone, or another path in the commit scope (a
 * materialized template, say) changed while the editor was open (design review NIT 2). The
 * findings are the lint of the draft as it now is.
 */
function editorStep(
  log: DecisionLog,
  edit: (absBodyPath: string) => Promise<string | null>,
  onNote: ((note: string) => void) | undefined,
): (plan: WritePlan, commitRequested: boolean) => () => Promise<AfterStage> {
  return (plan, commitRequested) => async () => {
    const d = plan.draft;
    if (d === null) return { findings: null, commit: true };
    const abs = join(log.git.root ?? "", d.path);
    const note = await edit(abs);
    // The editor may run other processes or wait on a person: drop what the operation cached.
    invalidateGitOperation();
    const bytes = await readIfPresent(abs);
    let commit: boolean;
    if (bytes === null) {
      commit = false;
      onNote?.(
        `${d.path} was removed while editing; the rendered draft is still staged. Restore it with \`git checkout -- ${d.path}\``,
      );
    } else if (note === null) {
      await log.git.add([d.path]);
      commit = true;
    } else if (sameBytes(bytes, d.rendered)) {
      commit = true;
    } else {
      commit = false;
      if (commitRequested) {
        onNote?.(
          `${d.path} changed while the editor failed; review it, then git add it and commit`,
        );
      }
    }
    if (commit && commitRequested) {
      const late = (await log.git.unstagedPaths(plan.commitScope)).filter((p) => p !== d.path);
      const [first] = late;
      if (first !== undefined) {
        commit = false;
        onNote?.(
          `${first} changed while the editor was open; review it, then git add it and commit`,
        );
      }
    }
    const text = decoder.decode(bytes ?? d.rendered);
    const findings = lintDocument(d.template, text, { file: d.path, subject: plan.subject });
    // Never commit a draft that `adr verify` then fails (design §7.2); it stays staged.
    if (commit && commitRequested && findings.length > 0) {
      commit = false;
      onNote?.(`${d.path} still has unfilled required sections; fill them in, then commit`);
    }
    return { findings, commit };
  };
}

/**
 * `adr new`: renders a draft, writes the body, any materialized template and the `proposed`
 * event, stages them, and commits with `commit` (default `[policy] auto_commit`).
 *
 * `edit` (CLI only; MCP never passes it) runs between staging and committing, on the absolute
 * body path. It resolves to `null` when the editor exited 0, else to a note for the user (spawn
 * error, exit status). `onNote` receives the notes about a skipped commit or a removed body,
 * without the "not committed: " prefix the CLI adds when a commit was requested.
 *
 * A draft with unfilled sections is never committed (design §7.2): without `edit` a commit is
 * refused (`ok: false`, nothing written); after `edit` the commit is skipped with a note.
 */
export async function proposeDecision(
  log: DecisionLog,
  input: ProposeInput,
  o: WriteOptions & {
    readonly edit?: (absBodyPath: string) => Promise<string | null>;
    readonly onNote?: (note: string) => void;
  } = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return withGitOperation(async () => {
    return write(
      log,
      "new",
      (read, c) =>
        planPropose(read, input, c, {
          refuseIncomplete: (o.commit ?? log.adr.autoCommit) && o.edit === undefined,
        }),
      o,
      deps,
      o.edit === undefined ? undefined : editorStep(log, o.edit, o.onNote),
    );
  });
}

/**
 * `adr accept`: lints the draft, hashes the body, writes `accepted` and a `superseded` event on
 * each declared target, stages them with the body, and commits with `commit`. When the targets
 * have globs the decision lacks, `copyScope` decides whether a `scoped` event copies them
 * (default `"suggest"`: no copy, and a note with the `adr scope` command that would).
 */
export async function acceptDecision(
  log: DecisionLog,
  input: { readonly id: string; readonly actor: Actor },
  o: WriteOptions & { readonly copyScope?: CopyScope } = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  const copyScope = o.copyScope ?? "suggest";
  // Decided once per command: the EventExistsError retry plans again without asking again.
  let copy: boolean | null = null;
  const tracked = await trackedFiles(log);
  return write(
    log,
    "accept",
    async (read, c) => {
      const plain = await planAccept(read, input, c, { tracked });
      if (!plain.ok) return plain;
      const id = plain.plan.subject;
      const offer = scopeToCopy(read, id);
      if (offer.globs.length === 0) return plain;
      if (copy === null) {
        if (typeof copyScope === "function") {
          copy = await copyScope(offer);
          // The callback may prompt a person or run other processes: drop what was cached.
          invalidateGitOperation();
        } else {
          copy = copyScope === "copy";
        }
      }
      if (copy) return planAccept(read, input, c, { copyGlobs: offer.globs, tracked });
      if (copyScope === "skip") return plain;
      const notes = [...(plain.plan.notes ?? []), copyScopeNote(id, offer)];
      return { ok: true, plan: { ...plain.plan, notes } };
    },
    o,
    deps,
  );
}

/** `adr supersede <id> --by <by>`: writes `superseded`, stages it, and commits with `commit`. */
export async function supersedeDecision(
  log: DecisionLog,
  input: {
    readonly id: string;
    readonly by: string;
    readonly reason?: string | null;
    readonly actor: Actor;
  },
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return write(log, "supersede", (read, c) => planSupersede(read, input, c), o, deps);
}

/**
 * `adr reject <id> --reason <text>`: writes `rejected`, stages it, and commits with `commit`. The
 * kind requires the reason; without one the write is refused (findings, nothing written).
 */
export async function rejectDecision(
  log: DecisionLog,
  input: ReasonInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return write(log, "reject", (read, c) => planReject(read, input, c), o, deps);
}

/** `adr withdraw <id> [--reason <text>]`: writes `withdrawn`, stages it, and commits with `commit`. */
export async function withdrawDecision(
  log: DecisionLog,
  input: ReasonInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return write(log, "withdraw", (read, c) => planWithdraw(read, input, c), o, deps);
}

/**
 * `adr deprecate <id> --reason <text>`: writes `deprecated`, stages it, and commits with `commit`.
 * The kind requires the reason, as for `rejectDecision`.
 */
export async function deprecateDecision(
  log: DecisionLog,
  input: ReasonInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return write(log, "deprecate", (read, c) => planDeprecate(read, input, c), o, deps);
}

/** `adr note <id> <text>`: writes `noted`, stages it, and commits with `commit`. */
export async function noteDecision(
  log: DecisionLog,
  input: { readonly id: string; readonly text: string; readonly actor: Actor },
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return write(log, "note", (read, c) => planNote(read, input, c), o, deps);
}

/**
 * `adr link <id> <target> [--rel <rel>]`: writes `linked`, stages it, and commits with `commit`.
 * Qualified targets name the log's `[[sources]]`; a link that exists already writes nothing.
 */
export async function linkDecision(
  log: DecisionLog,
  input: LinkInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  const configs = log.config?.sources ?? [];
  const sources = configs.map((s) => s.name);
  const kinds = new Map(configs.map((s) => [s.name, s.kind]));
  const logs = input.to.includes(":")
    ? (await readDecisionSources(log, { fetch: "cache" })).logs
    : undefined;
  return write(
    log,
    "link",
    (read, c) =>
      planLink(read, input, c, { sources, kinds, ...(logs === undefined ? {} : { logs }) }),
    o,
    deps,
  );
}

/**
 * `adr scope <id> --set|--add|--remove …`: writes one `scoped` event with the new set, stages it,
 * and commits with `commit`. An unchanged set writes nothing.
 */
export async function scopeDecision(
  log: DecisionLog,
  input: ScopeInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  const tracked = await trackedFiles(log);
  return write(log, "scope", (read, c) => planScope(read, input, c, { tracked }), o, deps);
}

/**
 * Replaces sections of a proposed decision's draft (design §6.6), stages the body, and commits
 * with `commit` (default `[policy] auto_commit`). A body with unstaged changes is a `UsageError`,
 * so nobody's unsaved edit is folded into this write; a body changed between plan and write is
 * `FileChangedError`. A commit is never made of a draft that fails its template lint: it is
 * refused (`ok: false`, nothing written), as for `proposeDecision` without an editor.
 */
export async function updateDraft(
  log: DecisionLog,
  input: UpdateDraftInput,
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return withGitOperation(async () => {
    const read = await readDecisions(log);
    const view = viewOf(read, resolveDecision(read, input.id));
    if (view.body_path !== null && (await log.git.unstagedPaths([view.body_path])).length > 0) {
      throw new UsageError(
        `${view.body_path} has unstaged changes; stage or discard them, or edit the draft by hand`,
      );
    }
    return write(
      log,
      "update",
      (read, c) =>
        planUpdateDraft(read, input, c, { refuseIncomplete: o.commit ?? log.adr.autoCommit }),
      o,
      deps,
    );
  });
}

const FOLLOW_NO_COMMIT_NOTE =
  "--follow-renames never commits; commit the scoped events with the renames";

/**
 * `adr scope [<decision>] --follow-renames` (design §6.8): rewrites the scope globs of the given
 * decision, or of every decision, after the renames staged against `HEAD`, and stages one
 * `scoped` event per changed decision. It never commits, whatever `[policy] auto_commit` says
 * (the events belong in the commit with the renames), so `o.commit: true` and a message are
 * `InvalidArgumentError`s. `dryRun` plans the same events and notes without writing anything.
 */
export async function followScopeRenames(
  log: DecisionLog,
  input: { readonly id?: string; readonly actor: Actor },
  o: WriteOptions & { readonly dryRun?: boolean } = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
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
    const doc = await write(
      log,
      "scope",
      (read, c) => planFollowRenames(read, { id: input.id ?? null, actor: input.actor }, staged, c),
      { ...o, commit: false },
      deps,
    );
    return log.adr.autoCommit && doc.ok && doc.affected.length > 0
      ? { ...doc, notes: [...doc.notes, FOLLOW_NO_COMMIT_NOTE] }
      : doc;
  });
}
