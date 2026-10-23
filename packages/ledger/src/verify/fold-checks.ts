import { kindFindings } from "../fold/project.js";
import type { AnyKind, FoldedLogOf, FoldedSubjectOf, OptionsOf } from "../kind/types.js";
import type { TemplateSourceFactory } from "../templates/source.js";
import { type Check, type CheckContext, mechanicalChecks } from "./checks.js";
import { templateCheck } from "./template-check.js";

type Folded = NonNullable<CheckContext["folded"]>;

/** The folded head subjects in scope, by id. */
function inScopeFolded(ctx: CheckContext, folded: Folded): FoldedSubjectOf<AnyKind>[] {
  return [...ctx.inScope].sort().flatMap((id) => {
    const s = folded.head.subjects.get(id);
    return s === undefined ? [] : [s];
  });
}

/** The fold's `transition/*` findings of in-scope subjects. */
export const transitions: Check = {
  id: "transitions",
  run(ctx) {
    const folded = ctx.folded ?? null;
    if (folded === null) return [];
    return inScopeFolded(ctx, folded).flatMap((s) => [...s.findings]);
  },
};

const optionsFor = (log: FoldedLogOf<AnyKind>, options: unknown) =>
  options === undefined ? log.kind.def.options : options;

/** The kind's `invariants` on each in-scope subject that folded (`options` default the kind's). */
export function invariantsCheck(options?: unknown): Check {
  return {
    id: "invariants",
    run(ctx) {
      const folded = ctx.folded ?? null;
      const invariants = folded?.head.kind.def.invariants;
      if (folded === null || invariants === undefined) return [];
      const o = optionsFor(folded.head, options);
      const fs = inScopeFolded(ctx, folded)
        .filter((s) => s.status !== null)
        .flatMap((s) => invariants.call(folded.head.kind.def, s, o));
      return kindFindings(folded.head, fs);
    },
  };
}

/**
 * The kind's `relate` on the whole head log, run once. A finding is kept when its subject or any
 * of its `related` subjects is in scope, so a staged change to a referenced subject still reports.
 */
export function relateCheck(options?: unknown): Check {
  return {
    id: "relate",
    run(ctx) {
      const folded = ctx.folded ?? null;
      const relate = folded?.head.kind.def.relate;
      if (folded === null || relate === undefined) return [];
      const o = optionsFor(folded.head, options);
      const fs = relate
        .call(folded.head.kind.def, folded.head, o)
        .filter(
          (f) => ctx.inScope.has(f.subject) || (f.related ?? []).some((id) => ctx.inScope.has(id)),
        );
      return kindFindings(folded.head, fs);
    },
  };
}

/** The mechanical checks plus the fold checks, in this order. */
export function foldChecks<K extends AnyKind>(
  kind: K,
  o: {
    /** Default `kind.def.options`. */
    readonly options?: OptionsOf<K>;
    /** `null` or absent: the template check returns nothing. */
    readonly templates?: TemplateSourceFactory | null;
  } = {},
): readonly Check[] {
  const options = o.options ?? kind.def.options;
  return Object.freeze([
    ...mechanicalChecks,
    transitions,
    invariantsCheck(options),
    relateCheck(options),
    templateCheck(o.templates ?? null),
  ]);
}
