/**
 * Scope globs (design §3.1, D-a): a small, fixed dialect matched against repo-relative POSIX paths.
 * `*` and `**` match dot-files, there are no extglobs and no negation, and matching runs two
 * dynamic programs over tokens, so no regular expression is ever built from a glob.
 */

export type GlobProblem =
  | "empty"
  | "too-long"
  | "control-char"
  | "absolute"
  | "dot-segment"
  | "empty-segment"
  | "trailing-slash"
  | "negation"
  | "globstar"
  | "unbalanced"
  | "nested-braces"
  | "brace-content"
  | "too-many-alternatives"
  | "trailing-escape";

export interface Glob {
  readonly source: string;
  /** No wildcard, class or brace: the glob names one path (after unescaping). */
  readonly literal: string | null;
  /** The leading segments that contain no wildcard, class or brace, unescaped and joined with "/"; "" if none. */
  readonly prefix: string;
  /** How many leading segments `prefix` spans (0 when `prefix` is ""). */
  readonly prefixSegments: number;
  /** `source` split at every unescaped "/", escapes kept: `segments.join("/") === source`. */
  readonly segments: readonly string[];
  matches(path: string): boolean;
}

/** The longest glob, in UTF-16 code units; equals the `maxLength` of adr's `scoped` items. */
export const MAX_GLOB_LENGTH = 500;
const MAX_ALTERNATIVES = 64;

type Token =
  | { readonly k: "lit"; readonly c: string }
  | { readonly k: "one" }
  | { readonly k: "star" }
  | {
      readonly k: "class";
      readonly neg: boolean;
      readonly ranges: readonly (readonly [number, number])[];
    };

type Part = Token | { readonly k: "group"; readonly alts: readonly (readonly Token[])[] };

/** A compiled segment: a globstar, or every token sequence its brace groups expand to. */
type Compiled =
  | { readonly globstar: true }
  | { readonly globstar: false; readonly seqs: Token[][] };

interface Scanned {
  readonly parts: Part[];
  /** Some group is `{}` or has an alternative holding an unescaped `**`. */
  readonly badGroup: boolean;
  /** An unescaped `**` outside classes and groups. */
  readonly outsideStars: boolean;
  /** Whether the segment has an unescaped `*`, `?`, `[` or `{`. */
  readonly wild: boolean;
}

type Failure = { readonly ok: false; readonly problem: GlobProblem; readonly message: string };

const REASONS: Record<GlobProblem, string> = {
  empty: "a glob can't be empty",
  "too-long": `longer than ${MAX_GLOB_LENGTH} characters`,
  "control-char": "contains a control character",
  absolute: "globs are relative to the repository root; remove the leading /",
  "dot-segment": '"." and ".." segments aren\'t allowed',
  "empty-segment": "empty path segment (//)",
  "trailing-slash": "ends with /; use <dir>/** for everything under a directory",
  negation: "negated globs aren't supported; remove the glob instead",
  globstar: "** must be a whole path segment",
  unbalanced: "unbalanced [ ] or { }",
  "nested-braces": "brace groups can't be nested",
  "brace-content": "a brace group needs at least one character and can't contain **",
  "too-many-alternatives": `brace groups expand to more than ${MAX_ALTERNATIVES} alternatives`,
  "trailing-escape": "ends with a lone \\",
};

function fail(source: string, problem: GlobProblem): Failure {
  const shown = source.length > 100 ? `${source.slice(0, 100)}…` : source;
  return {
    ok: false,
    problem,
    message: `invalid glob ${JSON.stringify(shown)}: ${REASONS[problem]}`,
  };
}

/** Splits at every unescaped "/"; a `\` keeps the next character, "/" included, in its segment. */
function splitSegments(source: string): string[] {
  const out: string[] = [];
  let cur = "";
  const cs = Array.from(source);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as string;
    if (c === "\\" && i + 1 < cs.length) {
      cur += c + cs[++i];
    } else if (c === "/") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** The segment with every escaping `\` removed (a lone trailing `\` escapes nothing and stays). */
function unescapeSegment(segment: string): string {
  let out = "";
  const cs = Array.from(segment);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as string;
    out += c === "\\" && i + 1 < cs.length ? cs[++i] : c;
  }
  return out;
}

const cp = (c: string) => c.codePointAt(0) as number;

/** U+0000–U+001F or U+007F. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Turns class content (`[` and `]` and the negation excluded) into code-point ranges. */
function classRanges(items: readonly { c: string; escaped: boolean }[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i] as { c: string };
    const dash = items[i + 1];
    const b = items[i + 2];
    if (dash !== undefined && !dash.escaped && dash.c === "-" && b !== undefined) {
      out.push([cp(a.c), cp(b.c)]);
      i += 2;
    } else {
      out.push([cp(a.c), cp(a.c)]);
    }
  }
  return out;
}

/** Phase 3 for one segment, also building its parts; a problem or the scan. */
function scanSegment(seg: string): { problem: GlobProblem } | { scan: Scanned; trailing: boolean } {
  const cs = Array.from(seg);
  const parts: Part[] = [];
  let trailing = false;
  let wild = false;
  let badGroup = false;
  let outsideStars = false;
  // The group being read: its alternatives, and per alternative whether it has an unescaped **.
  let group: { alts: Token[][]; stars: boolean[] } | null = null;
  // Whether the previous character, in the current context, was an unescaped `*`.
  let prevStar = false;

  const push = (t: Token) => {
    if (group === null) parts.push(t);
    else (group.alts[group.alts.length - 1] as Token[]).push(t);
  };

  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as string;
    if (c === "\\") {
      if (i + 1 >= cs.length) {
        trailing = true;
        break;
      }
      push({ k: "lit", c: cs[++i] as string });
      prevStar = false;
      continue;
    }
    if (c === "[") {
      wild = true;
      // Read the class up to its closing "]".
      let j = i + 1;
      let neg = false;
      if (cs[j] === "!" || cs[j] === "^") {
        neg = true;
        j++;
      }
      const items: { c: string; escaped: boolean }[] = [];
      let closed = false;
      let first = true;
      for (; j < cs.length; j++) {
        const d = cs[j] as string;
        if (d === "\\") {
          if (j + 1 >= cs.length) {
            trailing = true;
            break;
          }
          items.push({ c: cs[++j] as string, escaped: true });
        } else if (d === "]" && !first) {
          closed = true;
          break;
        } else {
          items.push({ c: d, escaped: false });
        }
        first = false;
      }
      if (!closed) return { problem: "unbalanced" };
      push({ k: "class", neg, ranges: classRanges(items) });
      i = j;
      prevStar = false;
      continue;
    }
    if (group === null) {
      if (c === "{") {
        wild = true;
        group = { alts: [[]], stars: [false] };
      } else if (c === "}") {
        return { problem: "unbalanced" };
      } else if (c === "*") {
        wild = true;
        if (prevStar) outsideStars = true;
        push({ k: "star" });
        prevStar = true;
        continue;
      } else if (c === "?") {
        wild = true;
        push({ k: "one" });
      } else {
        push({ k: "lit", c });
      }
      prevStar = false;
      continue;
    }
    // In a group.
    if (c === "{") return { problem: "nested-braces" };
    if (c === ",") {
      group.alts.push([]);
      group.stars.push(false);
    } else if (c === "}") {
      const only = group.alts.length === 1 && (group.alts[0] as Token[]).length === 0;
      if (only || group.stars.includes(true)) badGroup = true;
      parts.push({ k: "group", alts: group.alts });
      group = null;
    } else if (c === "*") {
      if (prevStar) group.stars[group.stars.length - 1] = true;
      push({ k: "star" });
      prevStar = true;
      continue;
    } else if (c === "?") {
      push({ k: "one" });
    } else {
      push({ k: "lit", c });
    }
    prevStar = false;
  }
  if (group !== null) return { problem: "unbalanced" };
  return { scan: { parts, badGroup, outsideStars, wild }, trailing };
}

/** Every token sequence a segment's parts expand to: one alternative spliced per group. */
function expand(parts: readonly Part[]): Token[][] {
  let seqs: Token[][] = [[]];
  for (const p of parts) {
    if (p.k === "group") {
      seqs = seqs.flatMap((s) => p.alts.map((a) => [...s, ...a]));
    } else {
      for (const s of seqs) s.push(p);
    }
  }
  return seqs;
}

function charMatches(t: Token, c: string): boolean {
  switch (t.k) {
    case "lit":
      return t.c === c;
    case "one":
      return true;
    case "star":
      return false;
    case "class": {
      const x = cp(c);
      return t.ranges.some(([lo, hi]) => lo <= x && x <= hi) !== t.neg;
    }
  }
}

/** Token-level dynamic program: whether `tokens` match all of `chars`. */
function matchTokens(tokens: readonly Token[], chars: readonly string[]): boolean {
  // An empty sequence, "." or "..": git paths have no such segment.
  if (tokens.length === 0) return false;
  if (tokens.length <= 2 && tokens.every((t) => t.k === "lit" && t.c === ".")) return false;
  let prev: boolean[] = new Array<boolean>(chars.length + 1).fill(false);
  prev[0] = true;
  for (const t of tokens) {
    const cur: boolean[] = new Array<boolean>(chars.length + 1).fill(false);
    if (t.k === "star") {
      let any = false;
      for (let j = 0; j <= chars.length; j++) {
        any ||= prev[j] as boolean;
        cur[j] = any;
      }
    } else {
      for (let j = 1; j <= chars.length; j++) {
        cur[j] = (prev[j - 1] as boolean) && charMatches(t, chars[j - 1] as string);
      }
    }
    prev = cur;
  }
  return prev[chars.length] as boolean;
}

/** Segment-level dynamic program; a last `**` matches one or more segments, any other zero or more. */
function matchSegments(compiled: readonly Compiled[], path: string): boolean {
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return false;
  const chars = segs.map((s) => Array.from(s));
  const n = segs.length;
  const g = compiled.length;
  // ok[j]: glob segments i.. match path segments j..; `next` holds row i + 1.
  let next: boolean[] = new Array<boolean>(n + 1).fill(false);
  next[n] = true;
  for (let i = g - 1; i >= 0; i--) {
    const c = compiled[i] as Compiled;
    const cur: boolean[] = new Array<boolean>(n + 1).fill(false);
    if (c.globstar) {
      if (i === g - 1) {
        for (let j = 0; j < n; j++) cur[j] = true;
      } else {
        let any = false;
        for (let j = n; j >= 0; j--) {
          any ||= next[j] as boolean;
          cur[j] = any;
        }
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (!next[j + 1]) continue;
        const cj = chars[j] as string[];
        cur[j] = c.seqs.some((s) => matchTokens(s, cj));
      }
    }
    next = cur;
  }
  return next[0] as boolean;
}

/** Parses a glob, reporting the first problem in the phase order of design §3.1. */
export function parseGlob(source: string): { readonly ok: true; readonly glob: Glob } | Failure {
  // Phase 1: the whole string.
  if (source === "") return fail(source, "empty");
  if (source.length > MAX_GLOB_LENGTH) return fail(source, "too-long");
  if (hasControlChar(source)) return fail(source, "control-char");
  if (source.startsWith("/")) return fail(source, "absolute");
  if (source.startsWith("!")) return fail(source, "negation");

  // Phase 2: segments.
  const segments = splitSegments(source);
  if (segments.some((s) => unescapeSegment(s) === "." || unescapeSegment(s) === "..")) {
    return fail(source, "dot-segment");
  }
  if (segments.slice(0, -1).some((s) => s === "")) return fail(source, "empty-segment");
  if (segments[segments.length - 1] === "") return fail(source, "trailing-slash");

  // Phase 3: structure.
  const scans: (Scanned | null)[] = [];
  let trailing = false;
  for (const s of segments) {
    if (s === "**") {
      scans.push(null);
      continue;
    }
    const r = scanSegment(s);
    if ("problem" in r) return fail(source, r.problem);
    scans.push(r.scan);
    trailing ||= r.trailing;
  }
  // Phases 4-6: brace content, globstars, alternatives.
  if (scans.some((s) => s?.badGroup)) return fail(source, "brace-content");
  if (scans.some((s) => s?.outsideStars)) return fail(source, "globstar");
  let alternatives = 1;
  for (const s of scans) {
    for (const p of s?.parts ?? []) if (p.k === "group") alternatives *= p.alts.length;
  }
  if (alternatives > MAX_ALTERNATIVES) return fail(source, "too-many-alternatives");
  // Phase 7: a lone trailing escape.
  if (trailing) return fail(source, "trailing-escape");

  const compiled: Compiled[] = scans.map((s) =>
    s === null ? { globstar: true } : { globstar: false, seqs: expand(s.parts) },
  );
  const plain = scans.map((s) => s !== null && !s.wild);
  const firstWild = plain.indexOf(false);
  const prefixSegments = firstWild === -1 ? segments.length : firstWild;
  const prefix = segments.slice(0, prefixSegments).map(unescapeSegment).join("/");
  const glob: Glob = {
    source,
    literal: firstWild === -1 ? prefix : null,
    prefix,
    prefixSegments,
    segments,
    matches: (path: string) => matchSegments(compiled, path),
  };
  return { ok: true, glob: Object.freeze(glob) };
}

/** The sources of `globs` that match `path`, in input order; invalid globs never match. */
export function globMatcher(globs: readonly string[]): (path: string) => string[] {
  const parsed: Glob[] = [];
  for (const g of globs) {
    const r = parseGlob(g);
    if (r.ok) parsed.push(r.glob);
  }
  return (path) => parsed.filter((g) => g.matches(path)).map((g) => g.source);
}

/** `path` as a literal glob: `\` before each of `* ? [ ] { } \`, and before a leading `!`. */
export function escapeGlob(path: string): string {
  const escaped = path.replace(/[*?[\]{}\\]/g, (c) => `\\${c}`);
  return escaped.startsWith("!") ? `\\${escaped}` : escaped;
}
