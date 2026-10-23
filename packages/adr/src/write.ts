import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type Actor,
  bodyFileName,
  bodySha256,
  ConfigError,
  classifyPath,
  compileKind,
  ENVELOPE_VERSION,
  type EventEnvelope,
  EventExistsError,
  eventDir,
  eventPath,
  FileExistsError,
  type Finding,
  finding,
  historyTemplates,
  InvalidArgumentError,
  isSubjectId,
  lintDocument,
  lintTemplate,
  newSubjectId,
  nextEventIdentity,
  overlayTree,
  parseEventFileName,
  parseTemplate,
  renderCommitMessage,
  renderTemplate,
  serializeEvent,
  slugify,
  type Template,
  type TemplateSource,
  type Trailer,
  templateHistoryRef,
  UsageError,
  writeEvents,
  writeNewFile,
} from "@nikovirtala/ledger";
import { adrKind, type DecisionView } from "./kind.js";
import {
  type DecisionLog,
  type DecisionsRead,
  readDecisions,
  readDecisionsFrom,
  resolveDecision,
} from "./log.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

/** `adr new|accept|supersede|reject|withdraw|deprecate --json` (design §5.5, §6.1). */
export interface WriteResultJson {
  readonly format: "adr-write/v1";
  readonly command: "new" | "accept" | "supersede" | "reject" | "withdraw" | "deprecate";
  readonly ok: boolean;
  /**
   * The decision after the write; before it when `ok` is false (`null` for a refused `new`).
   * After a commit it is read again from the log, so an acceptance committed on the main ref
   * carries its number; otherwise `number` is `null` until the acceptance lands on main.
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
export interface WritePlan {
  readonly command: "new" | "accept" | "supersede" | "event";
  readonly subject: string;
  /** New files, repo-relative path → bytes, in write order: body, materialized template, events. */
  readonly files: Readonly<Record<string, Uint8Array>>;
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
  readonly decision: DecisionView;
  readonly affected: readonly DecisionView[];
  /** Informational (new: the draft's template lint). */
  readonly findings: readonly Finding[];
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
const TEMPLATE_NAME = /^[a-z][a-z0-9-]*$/;
const MAX_TEXT_BYTES = 64 * 1024;
const SUBJECT_ATTEMPTS = 5;
const QUALIFIED_SUPERSESSION = "cross-log supersession isn't supported yet";

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const templatePath = (read: DecisionsRead, name: string) => `${read.root}/templates/${name}.md`;

/** A text argument within the 64 KiB cap and without NUL characters, else `UsageError`. */
function checkText(what: string, text: string): void {
  if (text.includes("\0")) throw new UsageError(`${what} must not contain NUL characters`);
  const size = encoder.encode(text).byteLength;
  if (size > MAX_TEXT_BYTES) {
    throw new UsageError(`${what} is ${size} bytes; the limit is ${MAX_TEXT_BYTES} (64 KiB)`);
  }
}

function checkReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  const r = reason.trim();
  if (r === "") throw new UsageError("--reason must not be empty");
  checkText("--reason", r);
  return r;
}

/** The view of a folded decision, else `UsageError` naming why it can't be used. */
function viewOf(read: DecisionsRead, id: string): DecisionView {
  const view = read.projection.views.get(id);
  if (view !== undefined) return view;
  if (read.projection.unreadable.includes(id)) {
    throw new UsageError(`decision ${id} uses a newer format; upgrade adr`);
  }
  throw new UsageError(`decision ${id} can't be read; run adr verify`);
}

/** A refusal finding about decision `subject`, on its body (or events directory). */
function refusal(read: DecisionsRead, rule: string, message: string, subject: string): Finding {
  const loaded = read.folded.subjects.get(subject)?.loaded;
  return finding({
    severity: "error",
    rule,
    message,
    file: loaded?.bodyPaths[0] ?? eventDir(read.layout, subject),
    subject,
    kind: adrKind.name,
  });
}

/** `"<type> is not allowed while <status>[; <status> is terminal]"`, as the fold words it. */
function illegal(type: string, status: string): string {
  const terminal = adrKind.machine.terminal.includes(status as never)
    ? `; ${status} is terminal`
    : "";
  return `${type} is not allowed while ${status}${terminal}`;
}

/** A new event of `subject`, sorting after its existing ones. */
function newEvent(
  read: DecisionsRead,
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
    kind: adrKind.name,
    schema: adrKind.schema,
    id,
    subject: o.subject,
    type: o.type,
    at,
    actor: o.actor,
    ...(o.reason === undefined || o.reason === null ? {} : { reason: o.reason }),
    data: o.data,
  };
}

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

const findingKey = (f: Finding) => [f.rule, f.subject ?? "", f.file ?? "", f.message].join("\0");

/**
 * The precheck (§6.3): folds the would-be log and refuses when the write adds any finding. Problems
 * that were already there don't block; the write can only add findings about what it touches.
 */
async function precheck(
  read: DecisionsRead,
  files: Readonly<Record<string, Uint8Array>>,
): Promise<{ after: DecisionsRead; added: Finding[] }> {
  const after = await readDecisionsFrom(overlayTree(read.tree, files), {
    layout: read.layout,
    adr: read.adr,
    numbering: read.numbering,
    ref: read.ref,
    commit: read.commit,
    notes: read.notes,
  });
  const before = new Set(read.findings.map(findingKey));
  return { after, added: after.findings.filter((f) => !before.has(findingKey(f))) };
}

function filesOf(
  events: readonly EventEnvelope[],
  read: DecisionsRead,
): Record<string, Uint8Array> {
  return Object.fromEntries(
    events.map((e) => [eventPath(read.layout, e), encoder.encode(serializeEvent(e))]),
  );
}

const pairsOf = (events: readonly EventEnvelope[]): Trailer[] =>
  events.flatMap((e): Trailer[] => [
    ["ADR", e.subject],
    ["ADR-Event", e.type],
  ]);

/** The template `new` uses: the repo's `<root>/templates/<name>.md`, else a built-in to copy. */
async function chooseTemplate(
  read: DecisionsRead,
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
    text = decoder.decode(bytes);
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
    requireSections: adrKind.def.templates?.requireSections ?? [],
  });
  if (lint.length > 0) return { ok: false, findings: lint };
  return { ok: true, template: parsed.template, materialize, path };
}

/** Plans `adr new`: a rendered body, a materialized template if needed, and `proposed`. */
export async function planPropose(
  read: DecisionsRead,
  input: ProposeInput,
  c: PlanContext,
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
  const chosen = await chooseTemplate(read, input.template ?? read.adr.defaultTemplate, c);
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
  Object.assign(files, filesOf([event], read));

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
      trailers: pairsOf([event]),
      decision: viewOf(after, id),
      affected: [],
      findings: lintDocument(t, rendered.text, { file: bodyPath, subject: id }),
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

/** Plans `adr accept`: `accepted` with the body hash, and `superseded` on each declared target. */
export async function planAccept(
  read: DecisionsRead,
  input: { readonly id: string; readonly actor: Actor },
  c: PlanContext,
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
  const events = [accepted, ...cascade];
  const files = filesOf(events, read);
  const { after, added } = await precheck(read, files);
  if (added.length > 0) return refused(added);
  const involved = sorted([id, ...targets]);
  const { scope, eventDirs } = commitScope(read, involved);
  const bodyPath = view.body_path ?? "";
  return {
    ok: true,
    plan: {
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
        body: targets.map((t) => {
          const v = viewOf(read, t);
          return `Supersedes ${v.display}: ${v.title}.`;
        }),
      },
      trailers: pairsOf(events),
      decision: viewOf(after, id),
      affected: targets.map((t) => viewOf(after, t)),
      findings: [],
    },
  };
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
  const files = filesOf([event], read);
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
      trailers: pairsOf([event]),
      decision: viewOf(after, id),
      affected: [viewOf(after, id)],
      findings: [],
    },
  };
}

/**
 * `{action}` of a commit that writes one event of each type (design §4.3), and what the title slot
 * names: the decision's title for the events that change whether it is decided, else its display.
 */
const ACTIONS = {
  proposed: { action: "propose to", names: "title" },
  accepted: { action: "decide to", names: "title" },
  rejected: { action: "decide not to", names: "title" },
  withdrawn: { action: "withdraw the proposal to", names: "title" },
  deprecated: { action: "deprecate", names: "display" },
  superseded: { action: "supersede", names: "display" },
  noted: { action: "add a note to", names: "display" },
  linked: { action: "link", names: "display" },
  scoped: { action: "set the scope of", names: "display" },
} as const satisfies Record<string, { action: string; names: "title" | "display" }>;

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
  const files = filesOf([event], read);
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
      trailers: pairsOf([event]),
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

/** What the editor step decided (§5.4 step 4a). */
export interface AfterStage {
  /** Draft lint findings to report instead of `plan.findings`; `null` keeps `plan.findings`. */
  readonly findings: readonly Finding[] | null;
  /** `false` skips the commit: the files stay written and staged, and `commit` is `null`. */
  readonly commit: boolean;
}

const isYaml = (path: string) => /\.ya?ml$/.test(path);

/**
 * Applies a plan (§5.4): refuses a commit whose scope has unstaged or needed untracked paths,
 * writes the files (removing them again if a write fails), stages them, runs `afterStage`, and
 * commits `plan.stage` plus the involved subjects' already-staged files with exact trailers.
 */
export async function applyPlan(
  log: DecisionLog,
  plan: WritePlan,
  o: {
    readonly commit: boolean;
    /** The commit message, without trailers; required when committing. */
    readonly message?: string;
    /** `message` is the user's own: append the trailers to its own trailer block, if it ends in one. */
    readonly mergeTrailers?: boolean;
    readonly afterStage?: () => Promise<AfterStage>;
  },
): Promise<{ written: string[]; commit: string | null; findings: readonly Finding[] }> {
  const { git } = log;
  if (o.commit && o.message === undefined) {
    throw new InvalidArgumentError("applyPlan needs a message to commit");
  }
  const stage = new Set(plan.stage);
  // This check runs before anything is written. It stays correct with an editor in between for
  // the body, which is in `plan.stage` and is re-staged after a successful edit; every other path
  // in the scope (a materialized template, say) is checked again by the editor step once the
  // editor has closed, because `--only` would commit its work-tree content.
  if (o.commit) {
    const unstaged = new Set(await git.unstagedPaths(plan.commitScope));
    const dirs = new Set(plan.eventDirs);
    const untracked = new Set([
      ...(await git.untrackedPaths(plan.commitScope.filter((p) => !dirs.has(p)))),
      ...(await git.untrackedPaths(plan.eventDirs)).filter(isYaml),
    ]);
    const dirty = sorted([...unstaged, ...untracked]).filter((p) => !stage.has(p));
    const [first] = dirty;
    if (first !== undefined) {
      throw new UsageError(
        unstaged.has(first)
          ? `${first} has unstaged changes; stage or discard them, or run without --commit`
          : `${first} is not tracked; git add it, or run without --commit`,
      );
    }
  }

  const eventPaths = new Set(plan.events.map((e) => eventPath(log.layout, e)));
  const written: string[] = [];
  try {
    for (const [path, bytes] of Object.entries(plan.files)) {
      if (eventPaths.has(path)) continue;
      await writeNewFile(git, path, bytes, { stage: false });
      written.push(path);
    }
    await writeEvents(git, log.layout, plan.events, { kind: log.compiled, stage: false });
  } catch (err) {
    const root = git.root ?? "";
    for (const path of written) await rm(join(root, path), { force: true });
    throw err;
  }
  await git.add(plan.stage);

  let findings = plan.findings;
  let commit = o.commit;
  if (o.afterStage !== undefined) {
    const after = await o.afterStage();
    findings = after.findings ?? plan.findings;
    commit = commit && after.commit;
  }

  let sha: string | null = null;
  if (commit) {
    const extra = (await git.stagedPaths(plan.commitScope)).filter((p) => !stage.has(p));
    const staged: Trailer[] = extra.filter(isYaml).flatMap((p): Trailer[] => {
      const c = classifyPath(log.layout, p);
      const name = c.area === "event" && !c.file.includes("/") ? parseEventFileName(c.file) : null;
      return c.area === "event" && c.subject !== null && name !== null
        ? [
            ["ADR", c.subject],
            ["ADR-Event", name.type],
          ]
        : [];
    });
    sha = await git.commit({
      message: o.message ?? "",
      mergeTrailers: o.mergeTrailers === true,
      trailers: [...staged, ...plan.trailers],
      only: sorted([...plan.stage, ...extra]),
    });
  }
  return { written: Object.keys(plan.files), commit: sha, findings };
}

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
): Promise<{ decision: DecisionView; affected: readonly DecisionView[] }> {
  if (sha === null) return { decision: plan.decision, affected: plan.affected };
  const read = await readDecisions({ ...log, commit: sha });
  const view = (v: DecisionView) => read.projection.views.get(v.id) ?? v;
  return { decision: view(plan.decision), affected: plan.affected.map(view) };
}

const SHORTENED_NOTE =
  "commit subject shortened to 72 characters; the full title is in the commit body";

/**
 * `--commit` needs an author and a committer identity; checked before anything is written, since
 * `GIT_AUTHOR_*` alone satisfies the author while `git commit` still fails on the committer.
 */
async function checkCommitIdentity(log: DecisionLog): Promise<void> {
  if ((await log.git.identity()) === null || (await log.git.committerIdentity()) === null) {
    throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
  }
}

/** The plan's commit message from `[commit] subject` (design §4), and whether it was shortened. */
function commitMessage(
  log: DecisionLog,
  command: string,
  plan: WritePlan,
): { message: string; shortened: boolean } {
  const parts = plan.commit;
  if (parts === null) throw new InvalidArgumentError("this write can't be committed");
  const r = renderCommitMessage(log.adr.commitSubject, {
    title: parts.title,
    vars: { action: parts.action, id: parts.id, display: parts.display, command },
    body: parts.body,
  });
  return { message: r.message, shortened: r.shortened };
}

/**
 * Plan, then apply, with the single `EventExistsError` retry (§5.4 steps 1–5). `o.message`
 * replaces the rendered commit message; `o.notes` come before the write's own notes. A plan with
 * no files and no events is reported as written without touching the repository.
 */
async function write(
  log: DecisionLog,
  command: WriteResultJson["command"],
  plan: (read: DecisionsRead, c: PlanContext) => Promise<PlanResult>,
  o: WriteOptions,
  deps: WriteDeps,
  afterStage?: (plan: WritePlan, commit: boolean) => () => Promise<AfterStage>,
): Promise<WriteResultJson> {
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
    if (r.plan.events.length === 0 && Object.keys(r.plan.files).length === 0) {
      return {
        format: "adr-write/v1",
        command,
        ok: true,
        decision: r.plan.decision,
        affected: r.plan.affected,
        written: [],
        commit: null,
        findings: r.plan.findings,
        notes,
      };
    }
    const rendered = commit ? commitMessage(log, command, r.plan) : null;
    const given = o.message ?? null;
    try {
      const applied = await deps.apply(log, r.plan, {
        commit,
        ...(rendered === null
          ? {}
          : { message: given ?? rendered.message, mergeTrailers: given !== null }),
        ...(afterStage === undefined ? {} : { afterStage: afterStage(r.plan, commit) }),
      });
      const views = await viewsAfter(log, r.plan, applied.commit);
      const own =
        applied.commit !== null && given === null && rendered?.shortened === true
          ? [SHORTENED_NOTE]
          : [];
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
      // Another process wrote the same event path in the same instant: writeEvents removed this
      // batch and applyPlan the new body and template, so plan again with a fresh clock, once.
      if (!(err instanceof EventExistsError) || attempt > 0) throw err;
    }
  }
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
    return {
      findings: lintDocument(d.template, text, { file: d.path, subject: plan.subject }),
      commit,
    };
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
  return write(
    log,
    "new",
    (read, c) => planPropose(read, input, c),
    o,
    deps,
    o.edit === undefined ? undefined : editorStep(log, o.edit, o.onNote),
  );
}

/**
 * `adr accept`: lints the draft, hashes the body, writes `accepted` and a `superseded` event on
 * each declared target, stages them with the body, and commits with `commit`.
 */
export async function acceptDecision(
  log: DecisionLog,
  input: { readonly id: string; readonly actor: Actor },
  o: WriteOptions = {},
  deps: WriteDeps = DEFAULT_DEPS,
): Promise<WriteResultJson> {
  return write(log, "accept", (read, c) => planAccept(read, input, c), o, deps);
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
