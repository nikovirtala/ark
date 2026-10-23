/** The path-to-subjects lookup (design §3.5): which subjects govern a path, by glob or anchor. */
import { InvalidArgumentError } from "../errors.js";
import type { EventDefs, FoldedLog } from "../kind/types.js";
import type { Anchor } from "./anchors.js";
import { globMatcher } from "./glob.js";
import { latestSet } from "./set.js";

export type ScopeVia =
  | { readonly type: "glob"; readonly glob: string }
  | { readonly type: "anchor"; readonly line: number };

export interface ScopeMatch {
  readonly source: string | null;
  readonly id: string;
  readonly via: readonly ScopeVia[];
}

/**
 * Compiles every subject's globs once. For a path, returns each subject at most once with every
 * glob that matched (in set order), then every anchor line in that path (ascending); local
 * subjects first, sorted by id, then qualified ones, sorted by `source:id`.
 */
export function scopeLookup(o: {
  readonly subjects: readonly { readonly id: string; readonly globs: readonly string[] }[];
  readonly anchors: readonly Anchor[];
}): (path: string) => ScopeMatch[] {
  const matchers = o.subjects.map((s) => ({ id: s.id, match: globMatcher(s.globs) }));
  const byPath = new Map<string, Anchor[]>();
  for (const a of o.anchors) {
    const list = byPath.get(a.path);
    if (list === undefined) byPath.set(a.path, [a]);
    else list.push(a);
  }
  return (path) => {
    const found = new Map<string, { source: string | null; id: string; via: ScopeVia[] }>();
    const entry = (source: string | null, id: string) => {
      const key = source === null ? id : `${source}:${id}`;
      let e = found.get(key);
      if (e === undefined) {
        e = { source, id, via: [] };
        found.set(key, e);
      }
      return e;
    };
    for (const m of matchers) {
      const globs = m.match(path);
      if (globs.length === 0) continue;
      const e = entry(null, m.id);
      for (const glob of globs) e.via.push({ type: "glob", glob });
    }
    const anchors = [...(byPath.get(path) ?? [])].sort((a, b) => a.line - b.line);
    for (const a of anchors) {
      const e = entry(a.source, a.id);
      const last = e.via[e.via.length - 1];
      if (last?.type === "anchor" && last.line === a.line) continue;
      e.via.push({ type: "anchor", line: a.line });
    }
    const key = (m: ScopeMatch) => (m.source === null ? m.id : `${m.source}:${m.id}`);
    return [...found.values()].sort((a, b) => {
      if ((a.source === null) !== (b.source === null)) return a.source === null ? -1 : 1;
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });
  };
}

/**
 * Every folded subject, sorted by id, with its status and the set of its latest applied
 * `kind.def.scope.event` (`[]` when none). Throws `InvalidArgumentError` for a kind without `scope`.
 */
export function scopedSubjects<S extends string, St, E extends EventDefs<S>>(
  log: FoldedLog<S, St, E>,
): { readonly id: string; readonly status: S; readonly globs: readonly string[] }[] {
  const scope = log.kind.def.scope;
  if (scope === undefined) {
    throw new InvalidArgumentError(`kind ${log.kind.name} has no scope event`);
  }
  const out: { id: string; status: S; globs: readonly string[] }[] = [];
  for (const s of log.subjects.values()) {
    if (s.status === null) continue;
    out.push({ id: s.id, status: s.status, globs: latestSet(s, scope.event) ?? [] });
  }
  return out;
}
