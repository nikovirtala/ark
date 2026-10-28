import {
  countOccurrences,
  type Finding,
  foldText,
  type StateHeader,
  searchExcerpt,
  searchTerms,
  UsageError,
} from "@nikovirtala/ledger";
import type { IssueStatus, IssueView } from "./kind.js";
import { type IssuesRead, readNotes } from "./log.js";
import { compareIssues, type NumberingJson, numberingJson, stateHeader } from "./views.js";

export type IssueSearchField = "id" | "title" | "body" | "comments";

/** One issue `issues search` found. */
export interface IssueSearchResultJson {
  readonly issue: IssueView;
  /** `stateHeader(view, read)`: the CLI's wording. */
  readonly header: StateHeader;
  readonly score: number;
  /** Fields with a hit, in the order id, title, body, comments (the display number is `id`). */
  readonly matched: readonly IssueSearchField[];
  /** The best matching line of the description or a comment, cut to about 160 characters; `null` if none. */
  readonly excerpt: string | null;
}

/** `issues search <query>… --json` and `issues_search`. */
export interface IssueSearchJson {
  readonly format: "issues-search/v1";
  /** The `[[sources]]` entry searched (`--source`), or `null` for this repository's log. */
  readonly source: string | null;
  readonly root: string;
  readonly ref: string | null;
  readonly commit: string | null;
  readonly numbering: NumberingJson;
  /** As given, trimmed. */
  readonly query: string;
  /** Folded, deduplicated, in query order. */
  readonly terms: readonly string[];
  readonly include_closed: boolean;
  /** Matching issues before `limit`. */
  readonly total: number;
  /** Closed issues that match but were left out; `0` with `include_closed`. */
  readonly closed_omitted: number;
  readonly results: readonly IssueSearchResultJson[];
  /** The read's findings of the listed issues and of the log as a whole. */
  readonly findings: readonly Finding[];
  /** `readNotes(read)`. */
  readonly notes: readonly string[];
}

const STATE_ORDER: readonly IssueStatus[] = ["in-progress", "open", "closed"];
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The description without its first `# ` title line; `""` when missing or not UTF-8. */
function bodyText(read: IssuesRead, id: string): string {
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

/** The text of every applied `commented` event, in fold order. */
function commentTexts(read: IssuesRead, id: string): string[] {
  return (read.folded.subjects.get(id)?.applied ?? []).flatMap(({ event: e }) =>
    e.type === "commented" ? [e.data.text] : [],
  );
}

/**
 * Full-text search of the log: an issue matches when every term of the folded query is a
 * substring of its folded id, display number, bare number, title, description or comments.
 * Ranked by score (10 for a term equal to the id, display or bare number, 5 in the title, up to 3
 * for description hits and 2 for comment hits), then in progress, open, closed, then number,
 * `opened_at` and id. Only open and in-progress issues unless `includeClosed`. Throws
 * `UsageError` for an invalid query or limit.
 */
export function searchIssues(
  read: IssuesRead,
  o: { readonly query: string; readonly includeClosed?: boolean; readonly limit?: number },
): IssueSearchJson {
  const terms = searchTerms(o.query);
  if (o.limit !== undefined && (!Number.isInteger(o.limit) || o.limit < 1)) {
    throw new UsageError("the search limit must be a positive integer");
  }
  const includeClosed = o.includeClosed === true;
  const found: IssueSearchResultJson[] = [];
  let closed = 0;
  for (const view of read.projection.views.values()) {
    const body = bodyText(read, view.id);
    const comments = commentTexts(read, view.id);
    const ids = [view.id, view.display, ...(view.number === null ? [] : [String(view.number)])].map(
      (s) => foldText(s).text,
    );
    const title = foldText(view.title).text;
    const foldedBody = foldText(body).text;
    const foldedComments = comments.map((c) => foldText(c).text).join("\n");
    const hit = new Set<IssueSearchField>();
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inId = ids.some((s) => s.includes(t));
      const inTitle = title.includes(t);
      const inBody = countOccurrences(foldedBody, t);
      const inComments = countOccurrences(foldedComments, t);
      if (!inId && !inTitle && inBody === 0 && inComments === 0) {
        all = false;
        break;
      }
      if (inId) hit.add("id");
      if (inTitle) hit.add("title");
      if (inBody > 0) hit.add("body");
      if (inComments > 0) hit.add("comments");
      score +=
        (ids.includes(t) ? 10 : 0) +
        (inTitle ? 5 : 0) +
        Math.min(3, inBody) +
        Math.min(2, inComments);
    }
    if (!all) continue;
    if (!includeClosed && view.state === "closed") {
      closed++;
      continue;
    }
    const lines = [
      ...body.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#")),
      ...comments.flatMap((c) => c.split("\n")),
    ];
    found.push({
      issue: view,
      header: stateHeader(view, read),
      score,
      matched: (["id", "title", "body", "comments"] as const).filter((f) => hit.has(f)),
      excerpt: searchExcerpt(lines, terms),
    });
  }
  found.sort(
    (a, b) =>
      b.score - a.score ||
      STATE_ORDER.indexOf(a.issue.state) - STATE_ORDER.indexOf(b.issue.state) ||
      compareIssues(a.issue, b.issue),
  );
  const results = found.slice(0, o.limit ?? Number.POSITIVE_INFINITY);
  const listed = new Set(results.map((r) => r.issue.id));
  return {
    format: "issues-search/v1",
    source: read.source,
    root: read.root,
    ref: read.ref,
    commit: read.commit,
    numbering: numberingJson(read),
    query: o.query.trim(),
    terms,
    include_closed: includeClosed,
    total: found.length,
    closed_omitted: closed,
    results,
    findings: read.findings.filter((f) => f.subject === null || listed.has(f.subject)),
    notes: readNotes(read),
  };
}
