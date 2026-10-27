import {
  type Actor,
  applySetOp,
  bodyFileName,
  compileKind,
  ENVELOPE_VERSION,
  type EventEnvelope,
  eventDir,
  eventPath,
  FileExistsError,
  type Finding,
  finding,
  globMatcher,
  InvalidArgumentError,
  lintDocument,
  lintTemplate,
  newSubjectId,
  nextEventIdentity,
  overlayTree,
  parseGlob,
  parseTemplate,
  renderTemplate,
  replaceSections,
  type SetOp,
  serializeEvent,
  slugify,
  type Template,
  type TemplateSource,
  type Trailer,
  UsageError,
} from "@nikovirtala/ledger";
import {
  ACTIONS,
  AS_DUPLICATE,
  CROSS_LOG_DECISION,
  CROSS_LOG_ISSUE,
  INIT_TITLE,
} from "./commit-actions.js";
import { ASSIGNEE } from "./kind/schemas.js";
import {
  type IssueView,
  issueKind,
  LABEL,
  labelPrefix,
  RELS,
  RESOLUTIONS,
  type Rel,
  type Resolution,
} from "./kind.js";
import { type IssuesRead, readIssuesFrom, resolveIssue, resolveTarget } from "./log.js";
import { myAddress } from "./views.js";

/** The write commands, as `issues-write/v1` names them. */
export type WriteCommand =
  | "new"
  | "edit"
  | "start"
  | "stop"
  | "close"
  | "reopen"
  | "assign"
  | "label"
  | "comment"
  | "link"
  | "unlink"
  | "scope";

/** What a plan needs besides the read: a clock, randomness and templates. */
export interface PlanContext {
  /** Clock for `nextEventIdentity`. */
  readonly now: () => number;
  /** ULID and subject-id randomness. */
  readonly random?: (buf: Uint8Array) => void;
  /** Recorded template versions, for `edit --section`. */
  readonly templates: TemplateSource;
  /** Built-in template texts by name, for `new`. */
  readonly builtins: Readonly<Record<string, string>>;
}

/** The parts of a commit message: the template's variables and the body. */
export interface CommitParts {
  /** `{action}`, the verb phrase, e.g. `close` or `set the labels of`. */
  readonly action: string;
  /** The text after `{action}`: the title for `new`, else a name built from displays. */
  readonly title: string;
  readonly id: string;
  readonly display: string;
  /** Body paragraphs, each wrapped at 72. */
  readonly body: readonly string[];
}

/** Everything one write command does, computed without touching git or the disk. */
export interface WritePlan {
  readonly command: WriteCommand;
  readonly subject: string;
  /** New files, repo-relative path → bytes, in write order: body, materialized template, events. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  /** Existing files to replace, written only if the file still holds `expected` (`edit`). */
  readonly replace?: Readonly<
    Record<string, { readonly bytes: Uint8Array; readonly expected: Uint8Array }>
  >;
  readonly events: readonly EventEnvelope[];
  /** Paths to stage: every new or replaced file. */
  readonly stage: readonly string[];
  /**
   * The paths a `--commit` takes and checks for unstaged or untracked changes: an event write's
   * events directory only, `new`'s body, template and events directory, `edit`'s body. Sorted.
   * `applyPlan` widens it with the `reach` of every issue whose `opened` event isn't in `HEAD`
   * yet, because a commit that holds an `opened` event needs the description and template too.
   * A committed issue's description stays out, so an unstaged edit of it never blocks or joins.
   */
  readonly commitScope: readonly string[];
  /** The events directories in `commitScope`; the rest of `commitScope` are file paths. */
  readonly eventDirs: readonly string[];
  /** The issues reachable from `subject` through local references after the write, by id. */
  readonly reach: Readonly<Record<string, ReachedIssue>>;
  /** For `new`: the body path, the rendered bytes and the template, for the editor step. */
  readonly draft: {
    readonly path: string;
    readonly rendered: Uint8Array;
    readonly template: Template;
  } | null;
  /** What the commit message is made of; `write()` renders it with `[commit] subject`. */
  readonly commit: CommitParts | null;
  /** One `Issue`/`Issue-Event` pair per plan event in write order; `Issue` alone for `edit`. */
  readonly trailers: readonly Trailer[];
  /** The issue after the write, folded on the overlay. */
  readonly issue: IssueView | null;
  /** `link`/`unlink`: the local target; `close --duplicate-of`: the canonical issue. */
  readonly affected: readonly IssueView[];
  /** Warnings the write adds, and `new`'s draft lint (informational). */
  readonly findings: readonly Finding[];
  /** The write's own notes (an unchanged set, an existing link, …). */
  readonly notes?: readonly string[];
}

/** What `applyPlan` needs of an issue a write reaches, to decide whether a `--commit` takes it. */
export interface ReachedIssue {
  /** The issue's events directory. */
  readonly dir: string;
  /** The path of the applied `opened` event; `null` without one. */
  readonly opened: string | null;
  /** The description paths (more than one means a duplicate id); empty when it is missing. */
  readonly bodies: readonly string[];
  /** `<root>/templates/<name>.md` of the template `opened` records; `null` without state. */
  readonly template: string | null;
  /** Local issue ids it references: current links without `:`, and `duplicateOf`. Sorted. */
  readonly refs: readonly string[];
}

export type PlanResult =
  | { readonly ok: true; readonly plan: WritePlan }
  | {
      readonly ok: false;
      readonly issue: IssueView | null;
      readonly findings: readonly Finding[];
      readonly notes?: readonly string[];
    };

const encoder = new TextEncoder();
const compiled = compileKind(issueKind);
const TEMPLATE_NAME = /^[a-z][a-z0-9-]*$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_DEPENDS_ON = 50;
const SUBJECT_ATTEMPTS = 5;
const ASSIGNEE_RE = new RegExp(ASSIGNEE);
const LABEL_RE = new RegExp(LABEL);
const RESOLUTION_TITLES: Readonly<Record<Resolution, string>> = {
  done: "",
  wontfix: " as won't fix",
  obsolete: " as obsolete",
  duplicate: ` ${AS_DUPLICATE}`,
};

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const templatePath = (read: IssuesRead, name: string) => `${read.root}/templates/${name}.md`;

/** A text argument within the 64 KiB cap and without NUL characters, else `UsageError`. */
export function checkText(what: string, text: string): void {
  if (text.includes("\0")) throw new UsageError(`${what} must not contain NUL characters`);
  const size = encoder.encode(text).byteLength;
  if (size > MAX_TEXT_BYTES) {
    throw new UsageError(`${what} is ${size} bytes; the limit is ${MAX_TEXT_BYTES} (64 KiB)`);
  }
}

/** `--reason`: trimmed and non-empty when given, else `null`. */
function checkReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  const r = reason.trim();
  if (r === "") throw new UsageError("--reason must not be empty");
  checkText("--reason", r);
  return r;
}

/** A title: trimmed, one line of 1 to 200 characters, else `UsageError`. */
function checkTitle(title: string): string {
  const t = title.trim();
  if (t === "" || t.length > 200 || /[\r\n]/.test(t)) {
    throw new UsageError("the title must be a single line of 1 to 200 characters");
  }
  return t;
}

/** The view of a folded issue (resolve it first). */
function viewOf(read: IssuesRead, id: string): IssueView {
  const view = read.projection.views.get(id);
  if (view === undefined)
    throw new UsageError(`${id} has no valid opened event; run issues verify`);
  return view;
}

/** A refusal finding about issue `subject`, on its body (or events directory). */
function refusal(read: IssuesRead, rule: string, message: string, subject: string): Finding {
  const loaded = read.folded.subjects.get(subject)?.loaded;
  return finding({
    severity: "error",
    rule,
    message,
    file: loaded?.bodyPaths[0] ?? eventDir(read.layout, subject),
    subject,
    kind: issueKind.name,
  });
}

/** The key the precheck compares findings by; kind messages use ids, so it's stable. */
export const findingKey = (f: Finding): string =>
  [f.rule, f.subject ?? "", f.file ?? "", f.message].join("\0");

/**
 * The precheck: folds the would-be log and returns the findings the write adds. Problems that
 * were already there never block; the caller refuses added errors and reports added warnings.
 */
async function precheck(
  read: IssuesRead,
  files: Readonly<Record<string, Uint8Array>>,
  replace: Readonly<Record<string, Uint8Array>> = {},
): Promise<{ after: IssuesRead; errors: Finding[]; warnings: Finding[] }> {
  const after = await readIssuesFrom(overlayTree(read.tree, { ...files, ...replace }), {
    layout: read.layout,
    issues: read.issues,
    numbering: read.numbering,
    sources: read.options.sources,
    decisions: read.decisions,
    ref: read.ref,
    commit: read.commit,
    notes: read.notes,
    configured: read.sources,
  });
  const before = new Set(read.findings.map(findingKey));
  const added = after.findings.filter((f) => !before.has(findingKey(f)));
  return {
    after,
    errors: added.filter((f) => f.severity === "error"),
    warnings: added.filter((f) => f.severity !== "error"),
  };
}

/** A new event of `subject`, sorting after its existing ones and `after`. */
function newEvent(
  read: IssuesRead,
  c: PlanContext,
  o: {
    readonly subject: string;
    readonly type: string;
    readonly data: Record<string, unknown>;
    readonly reason?: string | null;
    readonly actor: Actor;
    readonly after?: readonly EventEnvelope[];
  },
): EventEnvelope {
  const existing = (read.folded.subjects.get(o.subject)?.loaded.events ?? []).flatMap((e) =>
    e.event === null ? [] : [e.event],
  );
  const { at, id } = nextEventIdentity([...existing, ...(o.after ?? [])], {
    now: c.now,
    ...(c.random === undefined ? {} : { random: c.random }),
  });
  return {
    envelope: ENVELOPE_VERSION,
    kind: issueKind.name,
    schema: issueKind.schema,
    id,
    subject: o.subject,
    type: o.type,
    at,
    actor: o.actor,
    ...(o.reason === undefined || o.reason === null ? {} : { reason: o.reason }),
    data: o.data,
  };
}

function filesOf(read: IssuesRead, events: readonly EventEnvelope[]): Record<string, Uint8Array> {
  return Object.fromEntries(
    events.map((e) => [eventPath(read.layout, e), encoder.encode(serializeEvent(e))]),
  );
}

const pairsOf = (events: readonly EventEnvelope[]): Trailer[] =>
  events.flatMap((e): Trailer[] => [
    ["Issue", e.subject],
    ["Issue-Event", e.type],
  ]);

/** The issues reachable from `root` in `read` through local links and `duplicateOf`, by id. */
export function reachOf(read: IssuesRead, root: string): Record<string, ReachedIssue> {
  const reach: Record<string, ReachedIssue> = {};
  const queue = [root];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (Object.hasOwn(reach, id)) continue;
    const s = read.folded.subjects.get(id);
    if (s === undefined) continue;
    const st = s.state;
    const refs =
      st === null
        ? []
        : sorted([
            ...st.links.map((l) => l.to).filter((to) => !to.includes(":")),
            ...(st.duplicateOf === null ? [] : [st.duplicateOf]),
          ]);
    reach[id] = {
      dir: eventDir(read.layout, id),
      opened: s.applied.find((a) => a.event.type === "opened")?.path ?? null,
      bodies: [...s.loaded.bodyPaths],
      template: st === null ? null : templatePath(read, st.template.name),
      refs,
    };
    queue.push(...refs);
  }
  return reach;
}

/**
 * One note per `[[sources]]` entry that `targets` reference and that isn't cached: those
 * references are written unchecked.
 */
function uncachedNotes(read: IssuesRead, targets: readonly (string | null)[]): string[] {
  const names = new Set<string>();
  for (const t of targets) {
    const at = t?.indexOf(":") ?? -1;
    if (t === null || at < 0) continue;
    const name = t.slice(0, at);
    const source = read.options.sources?.get(name);
    if (source !== undefined && !source.local && source.subjects === null) names.add(name);
  }
  return [...names].map((n) => `${n} not fetched; the reference isn't checked`);
}

/** A plan that writes nothing: the views as they are, and `notes`. */
function emptyPlan(command: WriteCommand, view: IssueView, notes: readonly string[]): PlanResult {
  return {
    ok: true,
    plan: {
      command,
      subject: view.id,
      files: {},
      events: [],
      stage: [],
      commitScope: [],
      eventDirs: [],
      reach: {},
      draft: null,
      commit: null,
      trailers: [],
      issue: view,
      affected: [],
      findings: [],
      notes,
    },
  };
}

/** One event to plan on an existing issue. */
interface EventSpec {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly reason?: string | null;
}

/**
 * Plans events on an existing issue (`subject`, already resolved): the state machine and each
 * event's validation decide, then the precheck refuses added errors. The commit scope is the
 * issue's events directory; `applyPlan` adds the description and template only of reached issues
 * not yet in `HEAD`, so an unstaged edit of a committed description never blocks or joins it.
 */
async function planEvents(
  read: IssuesRead,
  c: PlanContext,
  o: {
    readonly command: WriteCommand;
    readonly subject: string;
    readonly events: readonly EventSpec[];
    readonly actor: Actor;
    readonly commit: (view: IssueView) => CommitParts;
    readonly affected?: (after: IssuesRead) => readonly IssueView[];
    readonly findings?: (after: IssuesRead) => readonly Finding[];
    readonly notes?: readonly string[];
    /**
     * `false` for `unlink`: errors the write adds don't refuse it and are reported as notes. A
     * finding whose message lists links (a cycle path, the parents) changes when one is removed.
     */
    readonly refuseAdded?: boolean;
  },
): Promise<PlanResult> {
  const id = o.subject;
  const view = viewOf(read, id);
  const refused = (findings: readonly Finding[]): PlanResult => ({
    ok: false,
    issue: view,
    findings,
  });
  let status = view.state as string;
  const events: EventEnvelope[] = [];
  for (const spec of o.events) {
    if (!issueKind.machine.allowed(status as never, spec.type)) {
      return refused([
        refusal(read, "transition/illegal", `${spec.type} is not allowed while ${status}`, id),
      ]);
    }
    status = issueKind.machine.types.get(spec.type)?.to ?? status;
    const event = newEvent(read, c, {
      subject: id,
      type: spec.type,
      data: spec.data,
      ...(spec.reason === undefined ? {} : { reason: spec.reason }),
      actor: o.actor,
      after: events,
    });
    const valid = compiled.validate(event, { file: null });
    if (!valid.ok) {
      return refused(valid.findings.map((f) => ({ ...f, subject: id, kind: issueKind.name })));
    }
    events.push(event);
  }
  const files = filesOf(read, events);
  const { after, errors, warnings } = await precheck(read, files);
  if (errors.length > 0 && o.refuseAdded !== false) return refused(errors);
  const notes = [...(o.notes ?? []), ...errors.map((f) => `${f.rule}: ${f.message}`)];
  const dir = eventDir(read.layout, id);
  return {
    ok: true,
    plan: {
      command: o.command,
      subject: id,
      files,
      events,
      stage: Object.keys(files),
      commitScope: [dir],
      eventDirs: [dir],
      reach: reachOf(after, id),
      draft: null,
      commit: o.commit(view),
      trailers: pairsOf(events),
      issue: after.projection.views.get(id) ?? view,
      affected: o.affected?.(after) ?? [],
      findings: [...warnings, ...(o.findings?.(after) ?? [])],
      ...(notes.length === 0 ? {} : { notes }),
    },
  };
}

const reasonBody = (reason: string | null) => (reason === null ? [] : [`Reason: ${reason}`]);

/** The template `new` uses: the repo's `<root>/templates/<name>.md`, else a built-in to copy. */
async function chooseTemplate(
  read: IssuesRead,
  name: string,
  c: PlanContext,
): Promise<
  | { ok: true; template: Template; materialize: string | null; path: string }
  | { ok: false; findings: Finding[] }
> {
  if (name.length > 64 || !TEMPLATE_NAME.test(name)) {
    throw new UsageError(`invalid template name ${JSON.stringify(name)}`);
  }
  const path = templatePath(read, name);
  const bytes = await read.tree.read(path);
  let text: string;
  let materialize: string | null = null;
  if (bytes !== null) {
    text = new TextDecoder().decode(bytes);
  } else {
    const builtin = Object.hasOwn(c.builtins, name) ? c.builtins[name] : undefined;
    if (builtin === undefined) {
      const known = Object.keys(c.builtins).sort().join(", ");
      throw new UsageError(`unknown template ${name}; add ${path} or use one of ${known}`);
    }
    text = builtin;
    materialize = builtin;
  }
  const parsed = parseTemplate(text, { path });
  if (!parsed.ok) return { ok: false, findings: parsed.findings };
  const lint = lintTemplate(parsed.template, {
    requireSections: issueKind.def.templates?.requireSections ?? [],
  });
  if (lint.length > 0) return { ok: false, findings: lint };
  return { ok: true, template: parsed.template, materialize, path };
}

/** Labels for `new --label`: valid, at most 50, sorted and deduplicated. */
function checkLabels(labels: readonly string[]): string[] {
  for (const l of labels) {
    if (!LABEL_RE.test(l)) throw new UsageError(`invalid label ${JSON.stringify(l)}`);
  }
  const set = sorted(labels);
  if (set.length > 50) throw new UsageError(`${set.length} labels; the limit is 50`);
  return set;
}

export interface OpenInput {
  readonly title: string;
  /** Default `[log] default_template`. */
  readonly template?: string;
  /** Section id → markdown. */
  readonly sections?: Readonly<Record<string, string>>;
  /** The parent issue, as any issue reference. */
  readonly parent?: string | null;
  /** Issues this one depends on, as any issue reference; at most 50. */
  readonly dependsOn?: readonly string[];
  readonly labels?: readonly string[];
  readonly actor: Actor;
}

/**
 * Plans `issues new`: a rendered body, a materialized template if needed, `opened` (with
 * `parent`), `labeled` for the labels and one `linked depends-on` per dependency. With
 * `refuseIncomplete` (a commit with no editor to fill the draft in), a draft that fails its
 * template lint is refused with those findings before any file is planned.
 */
export async function planOpen(
  read: IssuesRead,
  input: OpenInput,
  c: PlanContext,
  o: { readonly refuseIncomplete?: boolean } = {},
): Promise<PlanResult> {
  const title = checkTitle(input.title);
  const parent =
    input.parent === undefined || input.parent === null
      ? null
      : resolveTarget(read, input.parent, "part-of");
  const given = input.dependsOn ?? [];
  if (given.length > MAX_DEPENDS_ON) {
    throw new UsageError(`--depends-on can be given at most ${MAX_DEPENDS_ON} times`);
  }
  const dependsOn = [...new Set(given.map((d) => resolveTarget(read, d, "depends-on")))];
  const labels = checkLabels(input.labels ?? []);
  const chosen = await chooseTemplate(read, input.template ?? read.issues.defaultTemplate, c);
  if (!chosen.ok) return { ok: false, issue: null, findings: chosen.findings };
  const t = chosen.template;
  const sections = input.sections ?? {};
  for (const [id, text] of Object.entries(sections)) {
    if (!t.sections.some((s) => s.id === id)) {
      const ids = t.sections.map((s) => s.id).join(", ");
      throw new UsageError(`template ${t.name} has no section ${id}; its sections are ${ids}`);
    }
    checkText(`section ${id}`, text);
  }
  // Required sections left out get their guidance, which template lint reports until it is
  // replaced; optional ones stay empty, so a draft with every required section given is complete.
  const optional = Object.fromEntries(t.sections.filter((s) => !s.required).map((s) => [s.id, ""]));
  const rendered = renderTemplate(
    t,
    { title, sections: { ...optional, ...sections } },
    { missing: "guidance" },
  );
  if (!rendered.ok) throw new UsageError(rendered.findings.map((f) => f.message).join("; "));

  let id = "";
  let bodyPath = "";
  for (let attempt = 0; ; attempt++) {
    id = newSubjectId(c.random);
    bodyPath = `${read.root}/${read.layout.bodies}/${bodyFileName(id, slugify(title))}`;
    if (!read.folded.subjects.has(id) && (await read.tree.read(bodyPath)) === null) break;
    if (attempt + 1 >= SUBJECT_ATTEMPTS) throw new FileExistsError(bodyPath);
  }
  const lint = lintDocument(t, rendered.text, { file: bodyPath, subject: id }).map((f) => ({
    ...f,
    kind: issueKind.name,
  }));
  if (o.refuseIncomplete === true && lint.length > 0) {
    return { ok: false, issue: null, findings: lint };
  }
  const events: EventEnvelope[] = [];
  const add = (type: string, data: Record<string, unknown>) =>
    events.push(newEvent(read, c, { subject: id, type, data, actor: input.actor, after: events }));
  add("opened", {
    title,
    template: t.name,
    template_version: t.version,
    ...(parent === null ? {} : { parent }),
  });
  if (labels.length > 0) add("labeled", { set: labels });
  for (const to of dependsOn) add("linked", { to, rel: "depends-on" });
  for (const e of events) {
    const valid = compiled.validate(e, { file: null });
    if (!valid.ok) return { ok: false, issue: null, findings: valid.findings };
  }
  const body = encoder.encode(rendered.text);
  const files: Record<string, Uint8Array> = { [bodyPath]: body };
  if (chosen.materialize !== null) files[chosen.path] = encoder.encode(chosen.materialize);
  Object.assign(files, filesOf(read, events));

  const { after, errors, warnings } = await precheck(read, files);
  if (errors.length > 0) return { ok: false, issue: null, findings: errors };
  const dir = eventDir(read.layout, id);
  return {
    ok: true,
    plan: {
      command: "new",
      subject: id,
      files,
      events,
      stage: Object.keys(files),
      commitScope: sorted([bodyPath, chosen.path, dir]),
      eventDirs: [dir],
      reach: reachOf(after, id),
      draft: { path: bodyPath, rendered: body, template: t },
      commit: { action: ACTIONS.new, title, id, display: id, body: [] },
      trailers: pairsOf(events),
      issue: after.projection.views.get(id) ?? null,
      affected: [],
      findings: [...lint, ...warnings],
      notes: uncachedNotes(read, [parent, ...dependsOn]),
    },
  };
}

export interface EditInput {
  readonly id: string;
  /** The new `# ` heading. */
  readonly title?: string | null;
  /** Section id → markdown, replaced against the template version the issue was opened with. */
  readonly sections?: Readonly<Record<string, string>>;
}

const MAX_SECTIONS = 50;

/** The body with its first `# ` line replaced by `# <title>`, or one added at the top. */
function retitle(text: string, title: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.replace(/\r$/, "").startsWith("# ") || l === "#");
  if (at < 0) return `# ${title}\n\n${text}`;
  lines[at] = `# ${title}`;
  return lines.join("\n");
}

/**
 * Plans `issues edit --title/--section`: the body with its `# ` heading and the given sections
 * replaced, every other line kept, written only if the body still holds the bytes read. Works in
 * every state; the commit takes the body alone, plus the issue's staged events and template when
 * its `opened` event isn't in `HEAD` yet (see `applyPlan`). An unknown section or a missing heading is a
 * `UsageError`; an unchanged body plans nothing, with a note.
 */
export async function planEdit(
  read: IssuesRead,
  input: EditInput,
  c: PlanContext,
): Promise<PlanResult> {
  const id = resolveIssue(read, input.id);
  const view = viewOf(read, id);
  const sections = input.sections ?? {};
  const ids = Object.keys(sections);
  const title = input.title === undefined || input.title === null ? null : checkTitle(input.title);
  if (title === null && ids.length === 0) {
    throw new InvalidArgumentError("planEdit needs a title or sections");
  }
  if (ids.length > MAX_SECTIONS)
    throw new UsageError(`edit takes at most ${MAX_SECTIONS} sections`);
  for (const [section, text] of Object.entries(sections)) checkText(`section ${section}`, text);
  const body = read.folded.subjects.get(id)?.loaded.body ?? null;
  if (body === null) {
    return {
      ok: false,
      issue: view,
      findings: [refusal(read, "body/missing", "body file is missing", id)],
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
  } catch {
    return {
      ok: false,
      issue: view,
      findings: [refusal(read, "body/not-utf8", "body is not valid UTF-8", id)],
    };
  }
  let template: Template | null = null;
  let next = text;
  if (ids.length > 0) {
    const found = await c.templates.get(view.template.name, view.template.version);
    if (!found.ok) {
      const message =
        found.reason === "not-found"
          ? `template ${view.template.name} not found at ${found.path}`
          : `template ${view.template.name} has no version ${view.template.version} at ${found.path}`;
      return {
        ok: false,
        issue: view,
        findings: [refusal(read, `template/${found.reason}`, message, id)],
      };
    }
    template = found.template;
    const r = replaceSections(template, next, sections);
    if (!r.ok) {
      const [first] = r.findings;
      if (first?.rule === "render/unknown-section") {
        const known = template.sections.map((s) => s.id).join(", ");
        const unknown = ids.find((s) => !template?.sections.some((t) => t.id === s)) ?? "";
        throw new UsageError(
          `template ${template.name} has no section ${unknown}; its sections are ${known}`,
        );
      }
      if (first?.rule === "render/section-missing") {
        throw new UsageError(`${body.path}: ${first.message}; edit the file by hand`);
      }
      throw new UsageError(r.findings.map((f) => f.message).join("; "));
    }
    next = r.text;
  }
  if (title !== null) next = retitle(next, title);
  if (next === text) return emptyPlan("edit", view, ["nothing changed"]);
  const bytes = encoder.encode(next);
  const { after, errors, warnings } = await precheck(read, {}, { [body.path]: bytes });
  if (errors.length > 0) return { ok: false, issue: view, findings: errors };
  const lint =
    template === null || view.state === "closed"
      ? []
      : lintDocument(template, next, { file: body.path, subject: id }).map((f) => ({
          ...f,
          kind: issueKind.name,
        }));
  return {
    ok: true,
    plan: {
      command: "edit",
      subject: id,
      files: {},
      replace: { [body.path]: { bytes, expected: body.bytes } },
      events: [],
      stage: [body.path],
      commitScope: [body.path],
      eventDirs: [],
      reach: reachOf(after, id),
      draft: null,
      commit: { action: ACTIONS.edit, title: view.display, id, display: view.display, body: [] },
      trailers: [["Issue", id]],
      issue: after.projection.views.get(id) ?? view,
      affected: [],
      findings: [...warnings, ...lint],
    },
  };
}

/** A display followed by the title, for notes and body sentences. */
const named = (v: IssueView) => (v.display === v.id ? v.id : `${v.display} (${v.id})`);
const sentenceTitle = (title: string) =>
  title
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim();

/**
 * Plans `issues start`: `started`, and `assigned` with the actor's address when the issue has no
 * assignees. Starting a blocked issue warns (`issue/started-blocked`); it isn't refused.
 */
export async function planStart(
  read: IssuesRead,
  input: { readonly id: string; readonly actor: Actor },
  c: PlanContext,
  o: { readonly tracked?: readonly string[] } = {},
): Promise<PlanResult> {
  const id = resolveIssue(read, input.id);
  const view = viewOf(read, id);
  const notes: string[] = [];
  // Started, the issue's globs must match (?7): say so for each one that doesn't yet.
  if (o.tracked !== undefined) {
    notes.push(
      ...unmatchedGlobs(view.applies_to, o.tracked).map(
        (g) =>
          `${g} matches no tracked file; from this commit verify reports scope/glob-unmatched until a file matches, so commit the files with it or change the scope`,
      ),
    );
  }
  const events: EventSpec[] = [{ type: "started", data: {} }];
  if (view.assignees.length === 0) {
    const me = input.actor.kind === "agent" ? input.actor.on_behalf_of : input.actor.email;
    if (me !== null && me !== undefined && ASSIGNEE_RE.test(me)) {
      events.push({ type: "assigned", data: { set: [me] } });
    } else {
      notes.push(`${view.display} stays unassigned: you have no email; set git config user.email`);
    }
  } else {
    notes.push(`${view.display} is assigned to ${view.assignees.join(", ")}`);
  }
  const display = (x: string) => read.projection.views.get(x)?.display ?? x;
  return planEvents(read, c, {
    command: "start",
    subject: id,
    events,
    actor: input.actor,
    commit: (v) => ({ action: ACTIONS.start, title: v.display, id, display: v.display, body: [] }),
    findings: () =>
      view.blocked
        ? [
            finding({
              severity: "warning",
              rule: "issue/started-blocked",
              message: `${view.display} is blocked by ${view.blocked_by_open
                .map((b) => `${display(b)} (${read.projection.views.get(b)?.state ?? "unknown"})`)
                .join(", ")}; finish them first`,
              file: view.body_path ?? eventDir(read.layout, id),
              subject: id,
              kind: issueKind.name,
            }),
          ]
        : [],
    notes,
  });
}

/** Plans `issues stop`: `stopped`, with a reason when given. */
export function planStop(
  read: IssuesRead,
  input: { readonly id: string; readonly reason?: string | null; readonly actor: Actor },
  c: PlanContext,
): Promise<PlanResult> {
  const id = resolveIssue(read, input.id);
  const reason = checkReason(input.reason);
  return planEvents(read, c, {
    command: "stop",
    subject: id,
    events: [{ type: "stopped", data: {}, reason }],
    actor: input.actor,
    commit: (v) => ({
      action: ACTIONS.stop,
      title: v.display,
      id,
      display: v.display,
      body: reasonBody(reason),
    }),
  });
}

export interface CloseInput {
  readonly id: string;
  /** Default `done`, or `duplicate` with `of`. */
  readonly resolution?: string | null;
  /** `--duplicate-of`: the canonical issue, in this log. */
  readonly of?: string | null;
  readonly reason?: string | null;
  readonly actor: Actor;
}

/**
 * Plans `issues close`: `closed` with its resolution, and `of` for a duplicate. The kind's rules
 * (a reason unless done, the agent policy, duplicates of duplicates, cycles through the canonical
 * issue) refuse it through the precheck; flag combinations and `--duplicate-of` itself are
 * `UsageError`s.
 */
export async function planClose(
  read: IssuesRead,
  input: CloseInput,
  c: PlanContext,
): Promise<PlanResult> {
  const id = resolveIssue(read, input.id);
  const given = input.resolution ?? null;
  if (given !== null && !(RESOLUTIONS as readonly string[]).includes(given)) {
    throw new UsageError(`unknown --resolution ${given}; use ${RESOLUTIONS.join(", ")}`);
  }
  const ofInput = input.of ?? null;
  if (ofInput !== null && given !== null && given !== "duplicate") {
    throw new UsageError(`--duplicate-of can't be combined with --resolution ${given}`);
  }
  if (ofInput === null && given === "duplicate") {
    throw new UsageError("--resolution duplicate needs --duplicate-of <issue>");
  }
  const resolution: Resolution = ofInput !== null ? "duplicate" : ((given ?? "done") as Resolution);
  let of: string | null = null;
  if (ofInput !== null) {
    if (ofInput.trim().includes(":")) {
      throw new UsageError(
        `${ofInput.trim()} is in another log; a duplicate's canonical issue must be in this log (link it with relates-to and close as obsolete instead)`,
      );
    }
    of = resolveIssue(read, ofInput);
    if (of === id) throw new UsageError("an issue can't be a duplicate of itself");
  }
  const reason = checkReason(input.reason);
  const display = (x: string) => read.projection.views.get(x)?.display ?? x;
  const r = await planEvents(read, c, {
    command: "close",
    subject: id,
    events: [{ type: "closed", data: { resolution, ...(of === null ? {} : { of }) }, reason }],
    actor: input.actor,
    commit: (v) => ({
      action: ACTIONS.close,
      title: `${v.display}${RESOLUTION_TITLES[resolution]}${of === null ? "" : ` ${display(of)}`}`,
      id,
      display: v.display,
      body: reasonBody(reason),
    }),
    affected: (after) => {
      if (of === null) return [];
      const canonical = after.projection.views.get(id)?.canonical ?? of;
      const v = after.projection.views.get(canonical);
      return v === undefined ? [] : [v];
    },
  });
  if (r.ok || of === null) return r;
  // Closing B as a duplicate of C while A is a duplicate of B: A is closed, so re-point it first.
  const repoint = r.findings
    .filter((f) => f.rule === "issue/duplicate-of-duplicate" && f.subject !== id)
    .map(
      (f) =>
        `reopen ${display(f.subject ?? "")} and close it as a duplicate of ${display(of)} first`,
    );
  return repoint.length === 0 ? r : { ...r, notes: [...(r.notes ?? []), ...repoint] };
}

/** Plans `issues reopen`: `reopened`, whose reason the state machine requires. */
export function planReopen(
  read: IssuesRead,
  input: { readonly id: string; readonly reason?: string | null; readonly actor: Actor },
  c: PlanContext,
): Promise<PlanResult> {
  const id = resolveIssue(read, input.id);
  const reason = checkReason(input.reason);
  return planEvents(read, c, {
    command: "reopen",
    subject: id,
    events: [{ type: "reopened", data: {}, reason }],
    actor: input.actor,
    commit: (v) => ({
      action: ACTIONS.reopen,
      title: v.display,
      id,
      display: v.display,
      body: reasonBody(reason),
    }),
  });
}

/** Plans `issues comment`: `commented` with the text as given. */
export function planComment(
  read: IssuesRead,
  input: { readonly id: string; readonly text: string; readonly actor: Actor },
  c: PlanContext,
): Promise<PlanResult> {
  const id = resolveIssue(read, input.id);
  if (input.text.trim() === "") throw new UsageError("the comment text must not be empty");
  checkText("the comment text", input.text);
  return planEvents(read, c, {
    command: "comment",
    subject: id,
    events: [{ type: "commented", data: { text: input.text } }],
    actor: input.actor,
    commit: (v) => ({
      action: ACTIONS.comment,
      title: v.display,
      id,
      display: v.display,
      body: [],
    }),
  });
}

/** Which set `planSet` changes. */
export type SetKind = "assign" | "label" | "scope";

export interface SetInput {
  readonly id: string;
  /** Replace (`set`, `[]` clears), or `add` and `remove`; `me` stands for the actor (assign). */
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

/** The globs of `globs` that match none of `files`. */
function unmatchedGlobs(globs: readonly string[], files: readonly string[]): string[] {
  const matches = globMatcher(globs);
  const hit = new Set(files.flatMap((f) => matches(f)));
  return globs.filter((g) => !hit.has(g));
}

const SET_EVENTS = {
  assign: {
    type: "assigned",
    what: "assignee",
    of: "an assignee of",
    action: ACTIONS.assign,
    max: 20,
  },
  label: { type: "labeled", what: "label", of: "a label of", action: ACTIONS.label, max: 50 },
  scope: { type: "scoped", what: "glob", of: "in the scope of", action: ACTIONS.scope, max: 200 },
} as const;

/**
 * Plans `issues assign|label|scope` with a set operation: one whole-set event with the new set,
 * or nothing when the set doesn't change. `label --add` replaces a current label with the same
 * exclusive prefix, with a note; adding two of one exclusive prefix is refused by the precheck
 * (`issue/label-exclusive`). Notes name removed items that weren't there, added ones that were
 * and, for scope, globs that match none of `o.tracked`.
 */
export async function planSet(
  read: IssuesRead,
  kind: SetKind,
  input: SetInput,
  c: PlanContext,
  o: { readonly tracked?: readonly string[] } = {},
): Promise<PlanResult> {
  const id = resolveIssue(read, input.id);
  const view = viewOf(read, id);
  const spec = SET_EVENTS[kind];
  const me = (xs: readonly string[]): string[] =>
    xs.map((x) => (kind === "assign" && x === "me" ? myAddress(input.actor, "me") : x));
  let op: SetOp = {
    ...(input.op.set === undefined ? {} : { set: me(input.op.set) }),
    ...(input.op.add === undefined ? {} : { add: me(input.op.add) }),
    ...(input.op.remove === undefined ? {} : { remove: me(input.op.remove) }),
  };
  const current =
    kind === "assign" ? view.assignees : kind === "label" ? view.labels : view.applies_to;
  const notes: string[] = [];
  if (kind === "label" && op.set === undefined && (op.add ?? []).length > 0) {
    const exclusive = new Set(read.issues.exclusive);
    const adding = new Set(op.add);
    const prefixes = new Set(
      [...adding].map(labelPrefix).filter((p): p is string => p !== null && exclusive.has(p)),
    );
    const replaced = current.filter((l) => {
      const p = labelPrefix(l);
      return p !== null && prefixes.has(p) && !adding.has(l) && !(op.remove ?? []).includes(l);
    });
    if (replaced.length > 0) {
      op = { ...op, remove: [...(op.remove ?? []), ...replaced] };
      for (const l of replaced) notes.push(`replaced ${l} (${labelPrefix(l)} is exclusive)`);
    }
  }
  const validate = (item: string): string | null => {
    if (kind === "assign") {
      return ASSIGNEE_RE.test(item) ? null : `invalid assignee ${JSON.stringify(item)}`;
    }
    if (kind === "label")
      return LABEL_RE.test(item) ? null : `invalid label ${JSON.stringify(item)}`;
    const parsed = parseGlob(item);
    return parsed.ok ? null : parsed.message;
  };
  const result = applySetOp(current, op, {
    what: spec.what,
    validate,
    maxItems: spec.max,
    ...(input.names === undefined ? {} : { names: input.names }),
  });
  const shown = named(view);
  notes.push(
    ...result.absent.map((x) => `${x} is not ${spec.of} ${shown}`),
    ...result.present.map((x) => `${x} is already ${spec.of} ${shown}`),
  );
  if (!result.changed) return emptyPlan(kind, view, notes);
  if (kind === "scope" && o.tracked !== undefined) {
    // verify reports scope/glob-unmatched only for in-progress issues (?7).
    const when =
      view.state === "in-progress"
        ? "; verify (hooks and CI) reports scope/glob-unmatched until a file matches"
        : view.state === "open"
          ? `; verify reports scope/glob-unmatched once ${view.display} is started, until a file matches`
          : "";
    notes.push(
      ...unmatchedGlobs(result.set, o.tracked).map((g) => `${g} matches no tracked file${when}`),
    );
  }
  return planEvents(read, c, {
    command: kind,
    subject: id,
    events: [{ type: spec.type, data: { set: [...result.set] } }],
    actor: input.actor,
    commit: (v) => ({ action: spec.action, title: v.display, id, display: v.display, body: [] }),
    notes,
  });
}

export interface LinkInput {
  readonly id: string;
  /** Any target form of the design's "Reference forms". */
  readonly to: string;
  /** Default `relates-to`. */
  readonly rel?: string | null;
  readonly actor: Actor;
}

function checkRel(rel: string): Rel {
  if (!(RELS as readonly string[]).includes(rel)) {
    throw new UsageError(`unknown --rel ${rel}; use ${RELS.join(", ")}`);
  }
  return rel as Rel;
}

/** How a link's commit names its target, and the body sentence. */
function linkWords(
  read: IssuesRead,
  view: IssueView,
  rel: Rel,
  to: string,
): { title: string; body: string; shown: string } {
  const at = to.indexOf(":");
  if (at < 0) {
    const t = read.projection.views.get(to);
    const shown = t?.display ?? to;
    const title = t === undefined ? "" : `: ${sentenceTitle(t.title)}`;
    return { title: `${view.display} to ${shown}`, body: `${rel} ${shown}${title}.`, shown };
  }
  if (to.slice(0, at) === "adr" && read.decisions !== null) {
    const d = read.decisions.views.get(to.slice(at + 1));
    const shown = d?.display ?? to;
    const title = d === undefined ? "" : `: ${sentenceTitle(d.title)}`;
    return { title: `${view.display} to ${shown}`, body: `${rel} ${shown}${title}.`, shown };
  }
  const cross = rel === "implements" ? CROSS_LOG_DECISION : CROSS_LOG_ISSUE;
  return { title: `${view.display} ${cross}`, body: `${rel} ${to}.`, shown: to };
}

const affectedOf = (after: IssuesRead, to: string) => {
  const v = to.includes(":") ? undefined : after.projection.views.get(to);
  return v === undefined ? [] : [v];
};

/**
 * Plans `issues link`: `linked` in every state. The target resolves as the design's reference
 * forms say; a self-link is a `UsageError`, an existing link plans nothing with a note, and a
 * cycle or a second parent is refused by the precheck.
 */
export async function planLink(
  read: IssuesRead,
  input: LinkInput,
  c: PlanContext,
): Promise<PlanResult> {
  const rel = checkRel(input.rel ?? "relates-to");
  const id = resolveIssue(read, input.id);
  const view = viewOf(read, id);
  const to = resolveTarget(read, input.to, rel);
  if (to === id) throw new UsageError("an issue can't link to itself");
  const words = linkWords(read, view, rel, to);
  const links = read.folded.subjects.get(id)?.state?.links ?? [];
  if (links.some((l) => l.to === to && l.rel === rel)) {
    return emptyPlan("link", view, [
      `already linked: ${view.display} ${rel} ${words.shown}; nothing written`,
    ]);
  }
  const r = await planEvents(read, c, {
    command: "link",
    subject: id,
    events: [{ type: "linked", data: { to, rel } }],
    actor: input.actor,
    commit: (v) => ({
      action: ACTIONS.link,
      title: words.title,
      id,
      display: v.display,
      body: [words.body],
    }),
    affected: (after) => affectedOf(after, to),
    notes: uncachedNotes(read, [to]),
  });
  if (!r.ok && rel === "part-of" && r.findings.some((f) => f.rule === "issue/multiple-parents")) {
    const parent = view.parent ?? "";
    const shown = read.projection.views.get(parent)?.display ?? parent;
    return {
      ...r,
      notes: [
        `${view.display} already has a parent; unlink it first: issues unlink ${view.display} ${shown} --rel part-of`,
      ],
    };
  }
  return r;
}

/**
 * Plans `issues unlink`: `unlinked` for one current relation. The target is first matched
 * verbatim against the stored targets, so a dangling, unknown-source or wrong-kind link can always
 * be removed; only then is it resolved as `link` resolves it. Several relations to the target
 * without `rel` are a `UsageError`; none plans nothing, with a note. Removing a link can only
 * remove findings, but a finding that lists links (a cycle path, the parents) gets a new message
 * when one goes, so the precheck never refuses `unlink`: such errors are notes.
 */
export async function planUnlink(
  read: IssuesRead,
  input: LinkInput,
  c: PlanContext,
): Promise<PlanResult> {
  const rel = input.rel === undefined || input.rel === null ? null : checkRel(input.rel);
  const id = resolveIssue(read, input.id);
  const view = viewOf(read, id);
  const links = read.folded.subjects.get(id)?.state?.links ?? [];
  const given = input.to.trim();
  const ofRel = (l: { rel: Rel }) => rel === null || l.rel === rel;
  let candidates = links.filter((l) => l.to === given && ofRel(l));
  if (candidates.length === 0) {
    const resolved = new Set<string>();
    let first: unknown = null;
    for (const r of rel === null ? (["depends-on", "implements"] as const) : [rel]) {
      try {
        resolved.add(resolveTarget(read, given, r));
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        first ??= err;
      }
    }
    if (resolved.size === 0) throw first;
    candidates = links.filter((l) => resolved.has(l.to) && ofRel(l));
  }
  if (candidates.length === 0) {
    return emptyPlan("unlink", view, [
      `not linked: ${view.display}${rel === null ? "" : ` ${rel}`} ${given}; nothing written`,
    ]);
  }
  if (candidates.length > 1) {
    throw new UsageError(
      `${view.display} has several relations to ${given} (${candidates.map((l) => l.rel).join(", ")}); give --rel`,
    );
  }
  const link = candidates[0] as { to: string; rel: Rel };
  const words = linkWords(read, view, link.rel, link.to);
  return planEvents(read, c, {
    command: "unlink",
    subject: id,
    events: [{ type: "unlinked", data: { to: link.to, rel: link.rel } }],
    actor: input.actor,
    commit: (v) => ({
      action: ACTIONS.unlink,
      title: words.title,
      id,
      display: v.display,
      body: [words.body],
    }),
    affected: (after) => affectedOf(after, link.to),
    refuseAdded: false,
  });
}

/** `init --commit`'s commit parts. */
export const INIT_COMMIT: Omit<CommitParts, "id" | "display" | "body"> = Object.freeze({
  action: ACTIONS.init,
  title: INIT_TITLE,
});
