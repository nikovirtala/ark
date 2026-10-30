import {
  foldText,
  MemoryTree,
  NO_NUMBERING,
  type Numbering,
  UsageError,
} from "@nikovirtala/ledger";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG } from "./config.js";
import { type IssuesRead, readIssuesFrom } from "./log.js";
import { searchIssues } from "./search.js";
import {
  IDS,
  issueEvent,
  issueFiles,
  LAYOUT,
  numberingOf,
  type SubjectSpec,
} from "./test-support/events.js";
import { arbIssueHistory } from "./test-support/history.js";
import { stateHeader } from "./views.js";

const { A, B, C, D, E } = IDS;

const at = (n: number) => `2026-10-2${n}T09:00:00Z`;
const event = (id: string, type: string, n: number, o: Parameters<typeof issueEvent>[2] = {}) =>
  issueEvent(id, type, { ...o, at: at(n) });
const openedAt = (id: string, n: number, title: string) =>
  event(id, "opened", n, { data: { title, template: "task", template_version: 1 } });
const comment = (id: string, n: number, text: string) =>
  event(id, "commented", n, { data: { text } });

function readOf(subjects: SubjectSpec[], numbering: Numbering = NO_NUMBERING): Promise<IssuesRead> {
  return readIssuesFrom(new MemoryTree(issueFiles(subjects)), {
    layout: LAYOUT,
    issues: DEFAULT_ISSUES_CONFIG,
    numbering,
    sources: null,
  });
}

const ids = (doc: ReturnType<typeof searchIssues>) => doc.results.map((r) => r.issue.id);

describe("searchIssues", () => {
  const log = () =>
    readOf(
      [
        {
          id: A,
          events: [openedAt(A, 1, "Login fails on Safari")],
          body: "# Login fails on Safari\n\n## Goal\nThe session cookie is dropped at the Café.\n",
        },
        {
          id: B,
          events: [openedAt(B, 1, "Cache warmup"), event(B, "started", 2)],
          body: "# Cache warmup\n\n## Goal\nWarm the cache on deploy.\n",
        },
        {
          id: C,
          events: [
            openedAt(C, 1, "Old Safari bug"),
            event(C, "closed", 2, { data: { resolution: "done" }, reason: "fixed" }),
          ],
        },
        {
          id: D,
          events: [
            openedAt(D, 1, "Safari again"),
            event(D, "closed", 2, { data: { resolution: "duplicate", of: A }, reason: "same" }),
          ],
        },
        {
          id: E,
          events: [
            openedAt(E, 1, "Straße names"),
            comment(E, 2, "Seen in Safari 17"),
            comment(E, 3, "and again\nwith the login page"),
          ],
          body: "# Straße names\n",
        },
      ],
      numberingOf({ [A]: 1, [B]: 2, [C]: 3, [D]: 4, [E]: 42 }),
    );

  it("matches every term in any field, open and in-progress issues only", async () => {
    const read = await log();
    const doc = searchIssues(read, { query: "  safari  " });
    expect(doc).toMatchObject({
      format: "issues-search/v1",
      source: null,
      query: "safari",
      terms: ["safari"],
      include_closed: false,
      total: 2,
      closed_omitted: 2,
    });
    expect(ids(doc)).toEqual([A, E]);
    expect(doc.results[0]).toMatchObject({
      score: 5,
      matched: ["title"],
      excerpt: null,
      header: stateHeader(read.projection.views.get(A) ?? fail(), read),
    });
    expect(doc.results[1]).toMatchObject({
      score: 1,
      matched: ["comments"],
      excerpt: "Seen in Safari 17",
    });
  });

  it("ANDs the terms across fields", async () => {
    const read = await log();
    expect(ids(searchIssues(read, { query: "safari login" }))).toEqual([A, E]);
    expect(ids(searchIssues(read, { query: "safari cookie" }))).toEqual([A]);
    expect(ids(searchIssues(read, { query: "safari warmup" }))).toEqual([]);
  });

  it("searches the description without its title line", async () => {
    const read = await log();
    const doc = searchIssues(read, { query: "cookie" });
    expect(doc.results[0]).toMatchObject({
      score: 1,
      matched: ["body"],
      excerpt: "The session cookie is dropped at the Café.",
    });
    expect(ids(searchIssues(read, { query: "names" }))).toEqual([E]);
    expect(searchIssues(read, { query: "names" }).results[0]?.matched).toEqual(["title"]);
  });

  it("falls back to a heading when only headings match", async () => {
    const read = await readOf([
      {
        id: A,
        events: [openedAt(A, 1, "Ship it"), comment(A, 2, "Looks fine")],
        body: "# Ship it\n\n## Goal\nKeep the cookie.\n\n## Done when\nSafari keeps it.\n",
      },
    ]);
    expect(searchIssues(read, { query: "when" }).results[0]).toMatchObject({
      matched: ["body"],
      excerpt: "## Done when",
    });
    expect(searchIssues(read, { query: "cookie when" }).results[0]?.excerpt).toBe(
      "Keep the cookie.",
    );
  });

  it("folds case and accents as adr does", async () => {
    const read = await log();
    expect(ids(searchIssues(read, { query: "CAFE" }))).toEqual([A]);
    expect(ids(searchIssues(read, { query: "café" }))).toEqual([A]);
    expect(ids(searchIssues(read, { query: "strasse" }))).toEqual([]);
    expect(ids(searchIssues(read, { query: "straße" }))).toEqual([E]);
  });

  it("matches the id, the display and the bare number, with 10 for an exact one", async () => {
    const read = await log();
    for (const q of [E, "?42", "42"]) {
      const doc = searchIssues(read, { query: q });
      expect(ids(doc)).toEqual([E]);
      expect(doc.results[0]).toMatchObject({ score: 10, matched: ["id"] });
    }
    const part = searchIssues(read, { query: E.slice(0, 4) });
    expect(part.results[0]).toMatchObject({ score: 0, matched: ["id"] });
  });

  it("ranks by score, then in progress before open, then by number", async () => {
    const read = await readOf(
      [
        { id: A, events: [openedAt(A, 1, "Cache")] },
        { id: B, events: [openedAt(B, 1, "Cache"), event(B, "started", 2)] },
        { id: C, events: [openedAt(C, 1, "Cache")] },
        { id: D, events: [openedAt(D, 1, "Cache cache")], body: "# Cache cache\n\ncache\n" },
      ],
      numberingOf({ [A]: 3, [B]: 4, [C]: 2, [D]: 1 }),
    );
    const doc = searchIssues(read, { query: "cache" });
    expect(ids(doc)).toEqual([D, B, C, A]);
    expect(doc.results.map((r) => r.score)).toEqual([6, 5, 5, 5]);
  });

  it("includes closed issues, duplicates too, with includeClosed", async () => {
    const read = await log();
    const doc = searchIssues(read, { query: "safari", includeClosed: true });
    expect(ids(doc)).toEqual([A, C, D, E]);
    expect(doc).toMatchObject({ include_closed: true, total: 4, closed_omitted: 0 });
    expect(doc.results[2]?.header.warning).toBe(
      "DUPLICATE of ?1 (open). Track work on ?1; read ?1.",
    );
  });

  it("cuts to limit after ranking, and total counts every result", async () => {
    const read = await log();
    const doc = searchIssues(read, { query: "safari", includeClosed: true, limit: 1 });
    expect(ids(doc)).toEqual([A]);
    expect(doc.total).toBe(4);
    for (const limit of [0, -1, 1.5]) {
      expect(() => searchIssues(read, { query: "safari", limit })).toThrow(
        new UsageError("the search limit must be a positive integer"),
      );
    }
  });

  it("refuses an invalid query", async () => {
    const read = await log();
    expect(() => searchIssues(read, { query: " " })).toThrow(UsageError);
    expect(() =>
      searchIssues(read, { query: Array.from({ length: 11 }, (_, i) => `w${i}`).join(" ") }),
    ).toThrow(new UsageError("a search takes at most 10 words"));
  });

  it("keeps the findings of listed issues and the log, and the notes", async () => {
    const read = await readOf([
      { id: A, events: [openedAt(A, 1, "Safari"), event(A, "started", 2), event(A, "started", 3)] },
      { id: B, events: [openedAt(B, 1, "Other"), event(B, "started", 2), event(B, "started", 3)] },
    ]);
    expect(read.findings.some((f) => f.subject === B)).toBe(true);
    const doc = searchIssues(read, { query: "safari" });
    expect(doc.findings.some((f) => f.subject === A)).toBe(true);
    expect(doc.findings.every((f) => f.subject === null || f.subject === A)).toBe(true);
    expect(doc.notes).toEqual([
      "issue numbers are unavailable (no main branch); issues display by id",
    ]);
  });

  it("matches only issues with every term, and leaves closed ones out", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIssueHistory({ subjects: { min: 1, max: 6 }, duplicates: true }),
        fc.array(fc.constantFrom("a", "e", "o", "goal", "done", "x", "?1", "1"), {
          minLength: 1,
          maxLength: 3,
        }),
        fc.boolean(),
        async (h, words, includeClosed) => {
          const read = await readIssuesFrom(new MemoryTree(h.files), {
            layout: LAYOUT,
            issues: DEFAULT_ISSUES_CONFIG,
            numbering: NO_NUMBERING,
            sources: null,
          });
          const doc = searchIssues(read, { query: words.join(" "), includeClosed });
          const fields = (id: string) => {
            const v = read.projection.views.get(id) ?? fail();
            const subject = read.folded.subjects.get(id);
            const body = new TextDecoder().decode(subject?.loaded.body?.bytes ?? new Uint8Array());
            const comments = (subject?.applied ?? []).flatMap(({ event: e }) =>
              e.type === "commented" ? [e.data.text] : [],
            );
            return [v.id, v.display, v.title, body, ...comments].map((s) => foldText(s).text);
          };
          const has = (id: string) => doc.terms.every((t) => fields(id).some((f) => f.includes(t)));
          const found = new Set(ids(doc));
          for (const id of found) expect(has(id)).toBe(true);
          for (const r of doc.results) {
            if (r.excerpt === null) {
              expect(
                r.matched.length > 0 && r.matched.every((f) => f === "id" || f === "title"),
              ).toBe(true);
            }
          }
          if (!includeClosed) {
            for (const r of doc.results) expect(r.issue.state).not.toBe("closed");
          }
          for (const v of read.projection.views.values()) {
            if (v.state !== "closed" && !found.has(v.id)) {
              expect(doc.terms.every((t) => fields(v.id).some((f) => f.includes(t)))).toBe(false);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

function fail(): never {
  throw new Error("missing view");
}
