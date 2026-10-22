import { ConfigError } from "../errors.js";
import type { TreeReader } from "../git/tree.js";
import { parseBodyFileName } from "../identity/files.js";
import { eventDir, type LogLayout, normalizeLayout } from "../identity/layout.js";
import type { FetchedSource } from "./fetch.js";
import { parseQualifiedId } from "./qualified-id.js";

/** A log to resolve ids in: the local one (`name: null`) or a fetched source. */
export interface LogRef {
  readonly name: string | null;
  readonly kind: string;
  readonly layout: LogLayout;
  readonly tree: TreeReader;
  readonly commit: string | null;
}

export type Resolution =
  | { readonly ok: true; readonly log: LogRef; readonly subject: string }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unknown-source" | "not-found";
      readonly input: string;
    };

async function subjectExists(log: LogRef, id: string): Promise<boolean> {
  if ((await log.tree.list(eventDir(log.layout, id))).length > 0) return true;
  if (log.layout.bodies === null) return false;
  const dir = `${log.layout.root}/${log.layout.bodies}`;
  return (await log.tree.list(dir)).some((e) => {
    const name = e.path.slice(dir.length + 1);
    return !name.includes("/") && parseBodyFileName(name)?.id === id;
  });
}

/**
 * Resolves `id` in the local log or `source:id` in the named source. A subject exists when its
 * event directory has any entry or a body file carries its id.
 */
export async function resolveQualifiedId(
  input: string,
  logs: { readonly local: LogRef; readonly sources: ReadonlyMap<string, LogRef> },
): Promise<Resolution> {
  const q = parseQualifiedId(input);
  if (q === null) return { ok: false, reason: "malformed", input };
  const log = q.source === null ? logs.local : logs.sources.get(q.source);
  if (log === undefined) return { ok: false, reason: "unknown-source", input };
  if (!(await subjectExists(log, q.id))) return { ok: false, reason: "not-found", input };
  return { ok: true, log, subject: q.id };
}

/**
 * The `LogRef` for a fetched source: its `root`, else `defaultRoot` (the kind's), else
 * `ConfigError`.
 */
export function sourceLogRef(
  f: FetchedSource,
  o: { readonly layout: Omit<LogLayout, "root">; readonly defaultRoot?: string },
): LogRef {
  const root = f.config.root ?? o.defaultRoot;
  if (root === undefined) {
    throw new ConfigError(`source ${f.config.name} has no root; set root in its [[sources]] entry`);
  }
  return {
    name: f.config.name,
    kind: f.config.kind,
    layout: normalizeLayout({ ...o.layout, root }),
    tree: f.tree,
    commit: f.commit,
  };
}
