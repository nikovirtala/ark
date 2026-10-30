import {
  countOccurrences,
  type Finding,
  foldText,
  type StateHeader,
  searchExcerpt,
  searchTerms,
  UsageError,
} from "@nikovirtala/ledger";
import type { DecisionStatus, DecisionView } from "./kind.js";
import { type DecisionsRead, listingNotes } from "./log.js";
import { STATUS_ORDER } from "./scope.js";
import { compareViews, type NumberingJson, numberingJson, stateHeader } from "./views.js";

/** ledger's `foldText`, the folding `adr search` compares. */
export { foldText as fold } from "@nikovirtala/ledger";

export type SearchField = "id" | "title" | "body" | "notes";

/** One decision `adr search` found. */
export interface DecisionSearchResultJson {
  readonly decision: DecisionView;
  /** `stateHeader(view, read)`: the CLI's wording. */
  readonly header: StateHeader;
  readonly score: number;
  /** The fields with a hit, in the order id, title, body, notes (the display number is `id`). */
  readonly matched: readonly SearchField[];
  /**
   * The best matching line of the body or a note, cut to about 160 characters; a `#` heading
   * line of the body only when no other line matches; `null` if none (then every term matched
   * the id or the title).
   */
  readonly excerpt: string | null;
}

/** `adr search <query>… --json` and `adr_search` (design §6.4). */
export interface DecisionSearchJson {
  readonly format: "adr-search/v1";
  /** The `[[sources]]` entry searched (`--source`), or `null` for the local log. */
  readonly source: string | null;
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

const ACTIVE: ReadonlySet<DecisionStatus> = new Set(["proposed", "accepted"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

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
  const terms = searchTerms(o.query);
  if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1)) {
    throw new UsageError("the search limit must be a positive integer");
  }
  const includeInactive = o.includeInactive === true;
  const found: (DecisionSearchResultJson & { readonly view: DecisionView })[] = [];
  let inactive = 0;
  for (const view of read.projection.views.values()) {
    const body = bodyText(read, view.id);
    const notes = noteTexts(read, view.id);
    const id = foldText(view.id).text;
    const display = foldText(view.display).text;
    const title = foldText(view.title).text;
    const foldedBody = foldText(body).text;
    const foldedNotes = notes.map((n) => foldText(n).text).join("\n");
    const hit = new Set<SearchField>();
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inId = id.includes(t) || display.includes(t);
      const inTitle = title.includes(t);
      const inBody = countOccurrences(foldedBody, t);
      const inNotes = countOccurrences(foldedNotes, t);
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
    const described = body.split("\n").filter((l) => l.trim() !== "");
    const lines = [
      ...described.filter((l) => !l.startsWith("#")),
      ...notes.flatMap((n) => n.split("\n")),
    ];
    const headings = described.filter((l) => l.startsWith("#"));
    found.push({
      view,
      decision: view,
      header: stateHeader(view, read),
      score,
      matched: (["id", "title", "body", "notes"] as const).filter((f) => hit.has(f)),
      excerpt: searchExcerpt(lines, terms) ?? searchExcerpt(headings, terms),
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
    source: read.source,
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
