/**
 * The helpers a tool's write plans share: argument checks, subject views and refusals, new events
 * and their files and trailers, the precheck, the template `new` uses, and the loop that follows
 * staged renames in scope globs. A tool binds its kind, its messages and its read.
 */
import type { Actor, EventEnvelope } from "../envelope/types.js";
import { ENVELOPE_VERSION } from "../envelope/version.js";
import { serializeEvent } from "../envelope/yaml.js";
import { UsageError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import type { Projection } from "../fold/project.js";
import type { Trailer } from "../git/git.js";
import { overlayTree, type TreeReader } from "../git/tree.js";
import { eventDir, eventPath, type LogLayout } from "../identity/layout.js";
import type { LoadedSubject } from "../log/snapshot.js";
import { nextEventIdentity } from "../log/write.js";
import { globMatcher } from "../scope/glob.js";
import { followRenames, type Rename } from "../scope/renames.js";
import { lintTemplate } from "../templates/lint.js";
import { parseTemplate, type Template } from "../templates/parse.js";

/** The largest text argument (a section, a note, a reason), in UTF-8 bytes: 64 KiB. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** The template names `new` accepts, up to 64 characters. */
const TEMPLATE_NAME = /^[a-z][a-z0-9-]*$/;
/** The most globs a rename may leave a subject's scope with. */
const MAX_FOLLOWED_GLOBS = 200;

const encoder = new TextEncoder();

/** What the plan helpers read of a log: each subject's loaded files, and the layout. */
export interface PlanRead {
  readonly folded: {
    readonly subjects: ReadonlyMap<
      string,
      { readonly loaded: Pick<LoadedSubject, "events" | "bodyPaths"> }
    >;
  };
  readonly layout: LogLayout;
}

/** A text argument within `MAX_TEXT_BYTES` and without NUL characters, else `UsageError`. */
export function checkText(what: string, text: string): void {
  if (text.includes("\0")) throw new UsageError(`${what} must not contain NUL characters`);
  const size = encoder.encode(text).byteLength;
  if (size > MAX_TEXT_BYTES) {
    throw new UsageError(`${what} is ${size} bytes; the limit is ${MAX_TEXT_BYTES} (64 KiB)`);
  }
}

/** `--reason`: trimmed and non-empty when given, else `null`. */
export function checkReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  const r = reason.trim();
  if (r === "") throw new UsageError("--reason must not be empty");
  checkText("--reason", r);
  return r;
}

/** The key the precheck compares findings by; kind messages use ids, so it's stable. */
export const findingKey = (f: Finding): string =>
  [f.rule, f.subject ?? "", f.file ?? "", f.message].join("\0");

/**
 * The view of a folded subject, else `UsageError`: `unreadable(id)` when the subject uses a
 * newer format (when given), else `missing(id)`.
 */
export function subjectView<V>(
  projection: Pick<Projection<V>, "views" | "unreadable">,
  id: string,
  messages: {
    readonly missing: (id: string) => string;
    readonly unreadable?: (id: string) => string;
  },
): V {
  const view = projection.views.get(id);
  if (view !== undefined) return view;
  if (messages.unreadable !== undefined && projection.unreadable.includes(id)) {
    throw new UsageError(messages.unreadable(id));
  }
  throw new UsageError(messages.missing(id));
}

/** A refusal finding about `subject` of `kind`, on its body (or its events directory). */
export function refusal(
  read: PlanRead,
  kind: string,
  rule: string,
  message: string,
  subject: string,
): Finding {
  const loaded = read.folded.subjects.get(subject)?.loaded;
  return finding({
    severity: "error",
    rule,
    message,
    file: loaded?.bodyPaths[0] ?? eventDir(read.layout, subject),
    subject,
    kind,
  });
}

/** A new event of `subject`, sorting after its existing ones and `after`. */
export function newEvent(
  read: PlanRead,
  c: { readonly now: () => number; readonly random?: (buf: Uint8Array) => void },
  kind: { readonly name: string; readonly schema: string },
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
    kind: kind.name,
    schema: kind.schema,
    id,
    subject: o.subject,
    type: o.type,
    at,
    actor: o.actor,
    ...(o.reason === undefined || o.reason === null ? {} : { reason: o.reason }),
    data: o.data,
  };
}

/** Each event's file, path → serialized bytes, in event order. */
export function eventFiles(
  layout: LogLayout,
  events: readonly EventEnvelope[],
): Record<string, Uint8Array> {
  return Object.fromEntries(
    events.map((e) => [eventPath(layout, e), encoder.encode(serializeEvent(e))]),
  );
}

/**
 * One `[keys.subject, subject]`, `[keys.event, type]` pair per event, in event order. Unlike
 * `eventTrailers` it keeps repeated pairs: a plan's trailers name every event it writes.
 */
export const eventPairs = (
  events: readonly EventEnvelope[],
  keys: { readonly subject: string; readonly event: string },
): Trailer[] =>
  events.flatMap((e): Trailer[] => [
    [keys.subject, e.subject],
    [keys.event, e.type],
  ]);

/**
 * The precheck: folds the would-be log, `read.tree` with `files` and `replace` laid over it, with
 * `refold`, and returns it with the findings the write adds. Problems that were already there
 * are never in `added`; the tool decides which added findings refuse the write.
 */
export async function precheck<R extends { readonly findings: readonly Finding[] }>(
  read: { readonly tree: TreeReader; readonly findings: readonly Finding[] },
  files: Readonly<Record<string, Uint8Array>>,
  replace: Readonly<Record<string, Uint8Array>>,
  refold: (tree: TreeReader) => Promise<R>,
): Promise<{ after: R; added: Finding[] }> {
  const after = await refold(overlayTree(read.tree, { ...files, ...replace }));
  const before = new Set(read.findings.map(findingKey));
  return { after, added: after.findings.filter((f) => !before.has(findingKey(f))) };
}

/**
 * The template `new` uses: `<root>/templates/<name>.md` in `tree`, else the built-in `name` to
 * copy there (`materialize`). An invalid or unknown name is a `UsageError`; a template that
 * doesn't parse or fails the lint with `requireSections` gives its findings.
 */
export async function chooseTemplate(
  tree: TreeReader,
  root: string,
  name: string,
  builtins: Readonly<Record<string, string>>,
  requireSections: readonly string[],
): Promise<
  | { ok: true; template: Template; materialize: string | null; path: string }
  | { ok: false; findings: Finding[] }
> {
  if (name.length > 64 || !TEMPLATE_NAME.test(name)) {
    throw new UsageError(`invalid template name ${JSON.stringify(name)}`);
  }
  const path = `${root}/templates/${name}.md`;
  const bytes = await tree.read(path);
  let text: string;
  let materialize: string | null = null;
  if (bytes !== null) {
    text = new TextDecoder().decode(bytes);
  } else {
    const builtin = Object.hasOwn(builtins, name) ? builtins[name] : undefined;
    if (builtin === undefined) {
      const known = Object.keys(builtins).sort().join(", ");
      throw new UsageError(`unknown template ${name}; add ${path} or use one of ${known}`);
    }
    text = builtin;
    materialize = builtin;
  }
  const parsed = parseTemplate(text, { path });
  if (!parsed.ok) return { ok: false, findings: parsed.findings };
  const lint = lintTemplate(parsed.template, { requireSections });
  if (lint.length > 0) return { ok: false, findings: lint };
  return { ok: true, template: parsed.template, materialize, path };
}

/** The globs of `globs` that match none of `files`. */
export function unmatchedGlobs(globs: readonly string[], files: readonly string[]): string[] {
  const matches = globMatcher(globs);
  const hit = new Set(files.flatMap((f) => matches(f)));
  return globs.filter((g) => !hit.has(g));
}

/** The renamed files and the tracked files before (`HEAD`) and after (the index) them. */
export interface StagedRenames {
  readonly renames: readonly Rename[];
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * Follows `staged` in each view's scope globs, in id order, skipping views whose globs don't
 * change. For a changed view, `blocked(view, leaving)` returns the note to report instead when its
 * state forbids a new scope (`leaving` counts the renamed files that leave its scope), else
 * `null`. A changed scope over 200 globs is a `UsageError`. The notes then name renamed files no
 * glob can express (`skipped`) and files the scope newly covers (`gained`), and
 * `change(view, globs)` gives the view's change, or a `stop` that ends the loop and is returned.
 */
export function followRenamesChanges<
  V extends { readonly id: string; readonly applies_to: readonly string[] },
  C,
  S = never,
>(
  views: Iterable<V>,
  staged: StagedRenames,
  o: {
    readonly named: (view: V) => string;
    readonly blocked: (view: V, leaving: number) => string | null;
    readonly change: (
      view: V,
      globs: readonly string[],
    ) => { readonly change: C } | { readonly stop: S };
  },
):
  | { readonly ok: true; readonly changes: C[]; readonly notes: string[] }
  | { readonly ok: false; readonly stop: S } {
  const notes: string[] = [];
  const changes: C[] = [];
  for (const view of [...views].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const result = followRenames({ globs: view.applies_to, ...staged });
    if (!result.changed) continue;
    const named = o.named(view);
    const covers = globMatcher(view.applies_to);
    const blocked = o.blocked(view, staged.renames.filter((r) => covers(r.from).length > 0).length);
    if (blocked !== null) {
      notes.push(blocked);
      continue;
    }
    if (result.globs.length > MAX_FOLLOWED_GLOBS) {
      throw new UsageError(
        `following the renames gives ${named} ${result.globs.length} globs; the limit is ${MAX_FOLLOWED_GLOBS}`,
      );
    }
    for (const s of result.skipped) {
      notes.push(
        `${s.to} can't be written as a scope glob (${s.problem}); ${named} no longer covers it`,
      );
    }
    for (const path of result.gained) {
      notes.push(
        `${path} is now covered by ${named}'s scope but wasn't before the rename; check it`,
      );
    }
    const r = o.change(view, result.globs);
    if ("stop" in r) return { ok: false, stop: r.stop };
    changes.push(r.change);
  }
  return { ok: true, changes, notes };
}
