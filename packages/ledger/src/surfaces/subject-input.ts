import type { Numbering } from "../fold/numbering.js";
import type { AnyKind } from "../kind/types.js";

/** What a subject argument (an id or a display number) names. */
export type SubjectInput =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "not-found" | "numbers-unavailable" | "qualified";
      readonly input: string;
    };

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Resolves a subject argument. An existing canonical id wins (so `00000012` is an id when one
 * exists); otherwise the kind's `numbering.parse`, then the number map. Qualified ids
 * (`source:id`) are refused in phase 1.
 */
export function resolveSubjectInput(
  input: string,
  o: {
    readonly subjects: ReadonlySet<string>;
    readonly kind: AnyKind;
    readonly numbering: Numbering;
  },
): SubjectInput {
  const fail = (reason: "malformed" | "not-found" | "numbers-unavailable" | "qualified") =>
    ({ ok: false, reason, input }) as const;
  const s = input.trim();
  if (s === "" || s.length > 64 || hasControlChar(s)) return fail("malformed");
  if (s.includes(":")) return fail("qualified");
  if (o.subjects.has(s)) return { ok: true, id: s };
  const n = o.kind.def.numbering?.parse(s) ?? null;
  if (n === null) return fail("not-found");
  if (!o.numbering.available) return fail("numbers-unavailable");
  const id = o.numbering.byNumber.get(n);
  return id !== undefined && o.subjects.has(id) ? { ok: true, id } : fail("not-found");
}
