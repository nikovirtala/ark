import { type Finding, finding } from "../findings/finding.js";
import { bodySha256 } from "../identity/hash.js";
import { eventDir } from "../identity/layout.js";
import type {
  AnyKind,
  FoldedLogOf,
  FoldedSubjectOf,
  KindFinding,
  ProjectContext,
  ViewOf,
} from "../kind/types.js";
import type { Numbering } from "./numbering.js";

export interface Projection<P> {
  /** Folded subjects only, sorted by id. */
  readonly views: ReadonlyMap<string, P>;
  /** Not folded because the subject is unreadable (an unknown version). */
  readonly unreadable: readonly string[];
  /** Not folded for other reasons: no valid events, or a first event that isn't initial. */
  readonly unfoldable: readonly string[];
}

/**
 * Projects every folded subject with the kind's `project`. Numbers come from `o.numbering`, and
 * only for subjects with an applied `numbering.on` event in this log.
 */
export function projectLog<K extends AnyKind>(
  kind: K,
  log: FoldedLogOf<K>,
  o: { readonly numbering: Numbering },
): Projection<ViewOf<K>> {
  const { def } = kind;
  const subjects = log.subjects as ReadonlyMap<string, FoldedSubjectOf<AnyKind>>;
  const on = def.numbering?.on;
  const number = (id: string): number | null => {
    if (on === undefined) return null;
    const n = o.numbering.byId.get(id);
    if (n === undefined) return null;
    const applied = subjects.get(id)?.applied.some((a) => a.event.type === on) ?? false;
    return applied ? n : null;
  };
  const ctx: ProjectContext<string, unknown, AnyKind["def"]["events"]> = {
    log: log as FoldedLogOf<AnyKind>,
    number,
    display(id) {
      const n = number(id);
      return n === null || def.numbering === undefined ? id : def.numbering.format(n);
    },
    bodySha256(id) {
      const body = subjects.get(id)?.loaded.body;
      return body === undefined || body === null ? null : bodySha256(body.bytes);
    },
  };
  const views = new Map<string, ViewOf<K>>();
  const unreadable: string[] = [];
  const unfoldable: string[] = [];
  for (const [id, s] of subjects) {
    if (s.status !== null) views.set(id, def.project(s, ctx) as ViewOf<K>);
    else if (!s.loaded.readable) unreadable.push(id);
    else unfoldable.push(id);
  }
  return { views, unreadable, unfoldable };
}

/**
 * Turns a kind's findings into findings: the file is the event's when `event` names one of the
 * subject's events, else the subject's body, else its event directory; `kind` is set.
 */
export function kindFindings(log: FoldedLogOf<AnyKind>, fs: readonly KindFinding[]): Finding[] {
  const { layout } = log.snapshot;
  return fs.map((f) => {
    const loaded = log.subjects.get(f.subject)?.loaded;
    const eventPath =
      f.event === undefined ? undefined : loaded?.events.find((e) => e.event?.id === f.event)?.path;
    const file = eventPath ?? loaded?.bodyPaths[0] ?? eventDir(layout, f.subject);
    return finding({
      severity: f.severity,
      rule: f.rule,
      message: f.message,
      file,
      subject: f.subject,
      kind: log.kind.name,
    });
  });
}
