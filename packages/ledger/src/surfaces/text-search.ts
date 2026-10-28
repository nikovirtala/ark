import { UsageError } from "../errors.js";

const MAX_QUERY = 200;
const MAX_TERMS = 10;
const EXCERPT = 160;
const LEAD = 60;
const WORD_SLACK = 15;

/** A folded string and, for every folded UTF-16 offset (and its end), the original offset. */
export interface FoldedText {
  readonly text: string;
  readonly at: readonly number[];
}

/**
 * Case- and accent-insensitive form: per code point NFKD, combining marks (\p{M}) dropped,
 * lower-cased. `Café` → `cafe`, `ﬁ` → `fi`; `ß` and `ø` have no decomposition and stay as they are.
 */
export function foldText(s: string): FoldedText {
  let text = "";
  const at: number[] = [];
  let offset = 0;
  for (const c of s) {
    const f = c.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    text += f;
    for (let i = 0; i < f.length; i++) at.push(offset);
    offset += c.length;
  }
  at.push(offset);
  return { text, at };
}

/** Non-overlapping occurrences of `needle` in `hay`. */
export function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * The folded, deduplicated terms of a query, in query order. Throws `UsageError` for a query
 * that is empty after trimming, longer than 200 characters or holds a control character; for
 * more than 10 terms; and for a query with no term left.
 */
export function searchTerms(query: string): string[] {
  const q = query.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the rule is about control characters
  if (q === "" || q.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(q)) {
    throw new UsageError(
      `the search query must be 1 to ${MAX_QUERY} characters without control characters`,
    );
  }
  const terms = [
    ...new Set(
      foldText(q)
        .text.split(/\s+/)
        .filter((t) => t !== ""),
    ),
  ];
  if (terms.length > MAX_TERMS) throw new UsageError(`a search takes at most ${MAX_TERMS} words`);
  if (terms.length === 0) {
    throw new UsageError("the search query must contain a letter, digit or symbol");
  }
  return terms;
}

/**
 * The first of `lines` with the most distinct terms (at least one), whitespace collapsed; a line
 * over 160 characters is cut to a 160-character window starting 60 before the first hit, moved
 * to a word boundary within 15 characters, with "…" at each cut end. `null` when no line has a hit.
 */
export function searchExcerpt(lines: readonly string[], terms: readonly string[]): string | null {
  let best: { line: string; hits: number } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    const folded = foldText(line).text;
    const hits = terms.filter((t) => folded.includes(t)).length;
    if (hits > 0 && (best === null || hits > best.hits)) best = { line, hits };
  }
  if (best === null) return null;
  const { line } = best;
  if (line.length <= EXCERPT) return line;
  const f = foldText(line);
  const first = Math.min(...terms.map((t) => f.text.indexOf(t)).filter((i) => i >= 0));
  let start = Math.max(0, (f.at[first] ?? 0) - LEAD);
  if (start > 0 && line[start - 1] !== " ") {
    const space = line.indexOf(" ", start);
    if (space >= 0 && space - start <= WORD_SLACK) start = space + 1;
  }
  let end = Math.min(line.length, start + EXCERPT);
  if (end < line.length && line[end] !== " ") {
    const space = line.lastIndexOf(" ", end);
    if (space > start && end - space <= WORD_SLACK) end = space;
  }
  const cut = line.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${cut}${end < line.length ? "…" : ""}`;
}
