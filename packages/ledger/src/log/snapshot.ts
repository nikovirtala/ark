import type { CompiledKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { parseEventYaml } from "../envelope/yaml.js";
import { type Finding, finding } from "../findings/finding.js";
import type { TreeEntry, TreeReader } from "../git/tree.js";
import {
  type EventFileName,
  eventFileName,
  parseBodyFileName,
  parseEventFileName,
} from "../identity/files.js";
import { isSubjectId } from "../identity/ids.js";
import { classifyPath, type LogLayout } from "../identity/layout.js";
import { atToStamp } from "../identity/time.js";

export interface LoadedEvent {
  readonly path: string;
  readonly oid: string | null;
  readonly bytes: Uint8Array;
  /** The parsed file name, or `null` when it doesn't parse (`identity/file-name`). */
  readonly name: EventFileName | null;
  /** Non-null iff the file parsed and validated. */
  readonly event: EventEnvelope | null;
  /** Parse, schema and identity findings for this file. */
  readonly findings: readonly Finding[];
  /** `false` when the envelope or data-schema version is unknown to this reader. */
  readonly versionKnown: boolean;
}

export interface LoadedSubject {
  readonly id: string;
  /** Sorted by file name (chronological), not fold order. */
  readonly events: readonly LoadedEvent[];
  /** Sorted; more than one means a duplicate subject id. */
  readonly bodyPaths: readonly string[];
  /** Set iff there is exactly one body path. */
  readonly body: {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly oid: string | null;
  } | null;
  /** Findings for other entries of the subject's event directory (stray or non-regular files). */
  readonly findings: readonly Finding[];
  /** `false` when any event has an unknown version: a fold must skip the subject. */
  readonly readable: boolean;
}

export interface LogSnapshot {
  readonly kind: CompiledKind;
  readonly layout: LogLayout;
  readonly tree: TreeReader;
  readonly subjects: ReadonlyMap<string, LoadedSubject>;
  /** Findings not attributable to one subject's event directory. */
  readonly structural: readonly Finding[];
}

interface SubjectDraft {
  readonly events: TreeEntry[];
  readonly bodyPaths: string[];
  readonly bodyOids: Map<string, string | null>;
  readonly findings: Finding[];
}

const error = (rule: string, message: string, file: string, subject: string | null = null) =>
  finding({ severity: "error", rule, message, file, subject });

/** `git/unmerged` for an index entry git couldn't merge, else `identity/not-a-regular-file`. */
function entryTypeFinding(tree: TreeReader, entry: TreeEntry, subject: string | null): Finding {
  // The index reader lists an unmerged path once, as type "other".
  if (tree.label === "index" && entry.type === "other") {
    return error("git/unmerged", "unmerged path; resolve the conflict first", entry.path, subject);
  }
  const what = entry.type === "symlink" ? "a symlink" : "not a regular file";
  return error(
    "identity/not-a-regular-file",
    `${what}; a log holds regular files only`,
    entry.path,
    subject,
  );
}

function identityFindings(
  event: EventEnvelope,
  name: EventFileName | null,
  path: string,
  subject: string,
): Finding[] {
  const out: Finding[] = [];
  if (event.subject !== subject) {
    out.push(
      error(
        "identity/subject-mismatch",
        `event subject ${JSON.stringify(event.subject)} does not match its directory "${subject}"`,
        path,
        subject,
      ),
    );
  }
  if (
    name !== null &&
    (name.stamp !== atToStamp(event.at) ||
      name.rand !== event.id.slice(-4).toLowerCase() ||
      name.type !== event.type)
  ) {
    out.push(
      error(
        "identity/file-name-mismatch",
        `file name does not match the event; expected ${JSON.stringify(eventFileName(event))}`,
        path,
        subject,
      ),
    );
  }
  return out;
}

function loadEvent(
  kind: CompiledKind,
  entry: TreeEntry,
  bytes: Uint8Array,
  subject: string,
): LoadedEvent {
  const { path, oid } = entry;
  const name = parseEventFileName(path.slice(path.lastIndexOf("/") + 1));
  const findings: Finding[] = [];
  if (name === null) {
    findings.push(
      error(
        "identity/file-name",
        "event file name must be <stamp>-<rand>-<type>.yaml",
        path,
        subject,
      ),
    );
  }
  const loaded = (event: EventEnvelope | null, more: readonly Finding[], versionKnown = true) => ({
    path,
    oid,
    bytes,
    name,
    event,
    findings: [...findings, ...more.map((f) => ({ ...f, subject }))],
    versionKnown,
  });
  const parsed = parseEventYaml(bytes, { file: path });
  if (!parsed.ok) return loaded(null, [parsed.finding]);
  const r = kind.validate(parsed.doc, { file: path });
  if (!r.ok) return loaded(null, r.findings, r.versionKnown);
  // Identity checks read envelope fields, so they run only for valid events.
  return loaded(r.event, identityFindings(r.event, name, path, subject));
}

/**
 * Loads a log from a tree. Every listed path is classified (names and entry types only); blobs are
 * read and parsed only for the subjects in `o.subjects` when it's given.
 */
export async function loadLog(
  tree: TreeReader,
  o: {
    readonly kind: CompiledKind;
    readonly layout: LogLayout;
    readonly subjects?: ReadonlySet<string>;
  },
): Promise<LogSnapshot> {
  const { kind, layout } = o;
  const structural: Finding[] = [];
  const drafts = new Map<string, SubjectDraft>();
  const draft = (id: string): SubjectDraft => {
    let d = drafts.get(id);
    if (d === undefined) {
      d = { events: [], bodyPaths: [], bodyOids: new Map(), findings: [] };
      drafts.set(id, d);
    }
    return d;
  };

  for (const entry of await tree.list(`${layout.root}/${layout.events}`)) {
    const c = classifyPath(layout, entry.path);
    if (c.area !== "event") continue;
    if (c.subject === null || c.file.includes("/")) {
      structural.push(
        error(
          "identity/invalid-subject-dir",
          `event files belong in ${layout.events}/<subject-id>/`,
          entry.path,
        ),
      );
      continue;
    }
    const d = draft(c.subject);
    if (entry.type !== "file") d.findings.push(entryTypeFinding(tree, entry, c.subject));
    else if (/\.ya?ml$/.test(c.file)) d.events.push(entry);
    else {
      d.findings.push(
        finding({
          severity: "warning",
          rule: "identity/stray-file",
          message: "unexpected file in an event directory",
          file: entry.path,
          subject: c.subject,
        }),
      );
    }
  }

  if (layout.bodies !== null) {
    for (const entry of await tree.list(`${layout.root}/${layout.bodies}`)) {
      const c = classifyPath(layout, entry.path);
      if (c.area !== "body") continue;
      if (entry.type !== "file") {
        structural.push(entryTypeFinding(tree, entry, null));
        continue;
      }
      const parsed = c.file.includes("/") ? null : parseBodyFileName(c.file);
      if (parsed === null) {
        const prefix = c.file.slice(0, 8);
        structural.push(
          error(
            "identity/body-file-name",
            "body file name must be <subject-id>[-<slug>].md",
            entry.path,
            !c.file.includes("/") && isSubjectId(prefix) ? prefix : null,
          ),
        );
        continue;
      }
      const d = draft(parsed.id);
      d.bodyPaths.push(entry.path);
      d.bodyOids.set(entry.path, entry.oid);
    }
  }

  const wanted = [...drafts].filter(([id]) => o.subjects === undefined || o.subjects.has(id));
  const reads = wanted.flatMap(([, d]) => [
    ...d.events.map((e) => e.path),
    ...(d.bodyPaths.length === 1 ? d.bodyPaths : []),
  ]);
  const blobs = await tree.readMany(reads);
  const bytesOf = (path: string) => blobs.get(path) ?? new Uint8Array();

  const subjects = new Map<string, LoadedSubject>();
  for (const [id, d] of wanted.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const events = d.events
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => loadEvent(kind, entry, bytesOf(entry.path), id));
    const bodyPaths = [...d.bodyPaths].sort();
    const [only] = bodyPaths;
    subjects.set(id, {
      id,
      events,
      bodyPaths,
      body:
        bodyPaths.length === 1 && only !== undefined
          ? { path: only, bytes: bytesOf(only), oid: d.bodyOids.get(only) ?? null }
          : null,
      findings: d.findings,
      readable: events.every((e) => e.versionKnown),
    });
  }
  return { kind, layout, tree, subjects, structural };
}
