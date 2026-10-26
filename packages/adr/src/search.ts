import { type Finding, type StateHeader, UsageError } from "@nikovirtala/ledger";
import type { DecisionStatus, DecisionView } from "./kind.js";
import { type DecisionsRead, listingNotes } from "./log.js";
import { STATUS_ORDER } from "./scope.js";
import { compareViews, type NumberingJson, numberingJson, stateHeader } from "./views.js";

export type SearchField = "id" | "title" | "body" | "notes";

/** One decision `adr search` found. */
export interface DecisionSearchResultJson {
  readonly decision: DecisionView;
  /** `stateHeader(view, read)`: the CLI's wording. */
  readonly header: StateHeader;
  readonly score: number;
  /** The fields with a hit, in the order id, title, body, notes (the display number is `id`). */
  readonly matched: readonly SearchField[];
  /** The best matching line of the body or a note, cut to about 160 characters; `null` if none. */
  readonly excerpt: string | null;
}

/** `adr search <query>… --json` and `adr_search` (design §6.4). */
export interface DecisionSearchJson {
  readonly format: "adr-search/v1";
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  /** As given, trimmed. */
  readonly query: string;
  /** Folded, deduplicated, in query order. */
  readonly terms: readonly string[];
  readonly include_inactive: boolean;
  /** Matching decisions before `limit`. */
  readonly total: number;
  /** Decisions that match but aren't active; `0` with `include_inactive`. */
  readonly inactive_omitted: number;
  readonly results: readonly DecisionSearchResultJson[];
  /** The read's findings of the listed decisions and of the log as a whole. */
  readonly findings: readonly Finding[];
  /** `read.notes`, then the sources note. */
  readonly notes: readonly string[];
}

const MAX_QUERY = 200;
const MAX_TERMS = 10;
const EXCERPT = 160;
const LEAD = 60;
const WORD_SLACK = 15;
const ACTIVE: ReadonlySet<DecisionStatus> = new Set(["proposed", "accepted"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A folded string and, for every folded UTF-16 offset (and its end), the original offset. */
interface Folded {
  readonly text: string;
  readonly at: readonly number[];
}

/**
 * Case- and accent-insensitive form: per code point NFKD, combining marks dropped, lower-cased.
 * `Café` → `cafe` and `ﬁ` → `fi`; `ß` and `ø` have no decomposition and stay as they are.
 */
export function fold(s: string): Folded {
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

const count = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** The query's terms, or a `UsageError` for an empty, long, control-character or many-word query. */
function queryTerms(query: string): string[] {
  const q = query.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the rule is about control characters
  if (q === "" || q.length > MAX_QUERY || /[\u0000-\u001f\u007f]/.test(q)) {
    throw new UsageError(
      `the search query must be 1 to ${MAX_QUERY} characters without control characters`,
    );
  }
  const terms = [
    ...new Set(
      fold(q)
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

/** The body text without its first `# ` title line; `""` when missing or not UTF-8. */
function bodyText(read: DecisionsRead, id: string): string {
  const bytes = read.folded.subjects.get(id)?.loaded?.body?.bytes;
  if (bytes === undefined) return "";
  let text: string;
  try {
    text = decoder.decode(bytes).replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  const title = lines.findIndex((l) => l.startsWith("# "));
  if (title >= 0) lines.splice(title, 1);
  return lines.join("\n");
}

function noteTexts(read: DecisionsRead, id: string): string[] {
  return (read.folded.subjects.get(id)?.applied ?? []).flatMap((a) => {
    const text = (a.event.data as { text?: unknown } | null)?.text;
    return a.event.type === "noted" && typeof text === "string" ? [text] : [];
  });
}

/** The excerpt of the first line with the most distinct terms, windowed around the first hit. */
function excerpt(lines: readonly string[], terms: readonly string[]): string | null {
  let best: { line: string; hits: number } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    const folded = fold(line).text;
    const hits = terms.filter((t) => folded.includes(t)).length;
    if (hits > 0 && (best === null || hits > best.hits)) best = { line, hits };
  }
  if (best === null) return null;
  const { line } = best;
  if (line.length <= EXCERPT) return line;
  const f = fold(line);
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

/**
 * Full-text search of the log (design §8.1): a decision matches when every term of the folded
 * query is a substring of its folded id, display number, title, body or note texts. Ranked by
 * score (10 for a term equal to the id or number, 5 in the title, up to 3 for body hits and 2
 * for note hits), then status as `adr for` orders them, then list order. Only proposed and
 * accepted decisions unless `includeInactive`. Throws `UsageError` for an invalid query.
 */
export function searchDecisions(
  read: DecisionsRead,
  o: { readonly query: string; readonly includeInactive?: boolean; readonly limit?: number },
): DecisionSearchJson {
  const terms = queryTerms(o.query);
  if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1)) {
    throw new UsageError("the search limit must be a positive integer");
  }
  const includeInactive = o.includeInactive === true;
  const found: (DecisionSearchResultJson & { readonly view: DecisionView })[] = [];
  let inactive = 0;
  for (const view of read.projection.views.values()) {
    const body = bodyText(read, view.id);
    const notes = noteTexts(read, view.id);
    const id = fold(view.id).text;
    const display = fold(view.display).text;
    const title = fold(view.title).text;
    const foldedBody = fold(body).text;
    const foldedNotes = notes.map((n) => fold(n).text).join("\n");
    const hit = new Set<SearchField>();
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inId = id.includes(t) || display.includes(t);
      const inTitle = title.includes(t);
      const inBody = count(foldedBody, t);
      const inNotes = count(foldedNotes, t);
      if (!inId && !inTitle && inBody === 0 && inNotes === 0) {
        all = false;
        break;
      }
      if (inId) hit.add("id");
      if (inTitle) hit.add("title");
      if (inBody > 0) hit.add("body");
      if (inNotes > 0) hit.add("notes");
      score +=
        (t === id || t === display ? 10 : 0) +
        (inTitle ? 5 : 0) +
        Math.min(3, inBody) +
        Math.min(2, inNotes);
    }
    if (!all) continue;
    if (!includeInactive && !ACTIVE.has(view.status)) {
      inactive++;
      continue;
    }
    const lines = [
      ...body.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#")),
      ...notes.flatMap((n) => n.split("\n")),
    ];
    found.push({
      view,
      decision: view,
      header: stateHeader(view, read),
      score,
      matched: (["id", "title", "body", "notes"] as const).filter((f) => hit.has(f)),
      excerpt: excerpt(lines, terms),
    });
  }
  found.sort(
    (a, b) =>
      b.score - a.score ||
      STATUS_ORDER.indexOf(a.view.status) - STATUS_ORDER.indexOf(b.view.status) ||
      compareViews(a.view, b.view),
  );
  const results = found.slice(0, o.limit ?? Number.POSITIVE_INFINITY).map(({ view: _, ...r }) => r);
  const listed = new Set(results.map((r) => r.decision.id));
  return {
    format: "adr-search/v1",
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    query: o.query.trim(),
    terms,
    include_inactive: includeInactive,
    total: found.length,
    inactive_omitted: inactive,
    results,
    findings: read.findings.filter((f) => f.subject === null || listed.has(f.subject)),
    notes: listingNotes(read),
  };
}
