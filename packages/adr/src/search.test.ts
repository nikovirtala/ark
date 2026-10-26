import { MemoryTree, NO_NUMBERING, type Numbering, UsageError } from "@nikovirtala/ledger";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADR_CONFIG } from "./config.js";
import { readDecisionsFrom } from "./log.js";
import { fold, searchDecisions } from "./search.js";
import { arbAdrHistory } from "./test-support/decision-arbs.js";
import {
  decisionEvent,
  decisionFiles,
  hashOf,
  LAYOUT,
  numberingOf,
  proposedData,
  type SubjectSpec,
} from "./test-support/events.js";

const A = "a7c2m9xd";
const B = "k3f9q8a1";
const C = "m2x7p4d2";
const D = "r4tw9xd1";

const at = (d: string) => `2026-${d}T10:00:00Z`;
const ev = (id: string, type: string, d: string, o: Record<string, unknown> = {}) =>
  decisionEvent(id, type, { at: at(d), ...o });
const proposed = (id: string, d: string, title: string) =>
  ev(id, "proposed", d, { data: proposedData(title) });
const accepted = (id: string, d: string, body: string) =>
  ev(id, "accepted", d, { data: { body_sha256: hashOf(body) } });
const noted = (id: string, d: string, text: string) => ev(id, "noted", d, { data: { text } });

function read(subjects: SubjectSpec[], o: { numbering?: Numbering; sources?: string[] } = {}) {
  return readDecisionsFrom(new MemoryTree(decisionFiles(subjects)), {
    layout: LAYOUT,
    adr: DEFAULT_ADR_CONFIG,
    numbering: o.numbering ?? NO_NUMBERING,
    ...(o.sources === undefined ? {} : { sources: o.sources }),
  });
}

const A_BODY =
  "# Use DynamoDB for orders\n\n## Context\nOrders need a store.\n\n## Decision\nDynamoDB.\n";
const B_BODY =
  "# Use Aurora for orders\n\n## Context\nEvery service that writes order state uses Aurora.\nOrders, orders, orders and orders.\n";
const C_BODY = "# Cache session tokens\n\n## Context\nTokens are slow to verify. Café nearby.\n";
const D_BODY = "# Batch the export\n\n## Context\nThe nightly export.\n";

/** A superseded by B (ADR-0001, ADR-0002); C proposed with a note; D rejected. */
const LOG = (): SubjectSpec[] => [
  {
    id: A,
    body: A_BODY,
    events: [
      proposed(A, "03-01", "Use DynamoDB for orders"),
      accepted(A, "03-02", A_BODY),
      ev(A, "superseded", "04-02", { data: { by: B } }),
    ],
  },
  {
    id: B,
    body: B_BODY,
    events: [proposed(B, "04-01", "Use Aurora for orders"), accepted(B, "04-02", B_BODY)],
  },
  {
    id: C,
    body: C_BODY,
    events: [proposed(C, "05-01", "Cache session tokens"), noted(C, "05-02", "Ask the ﬁle team.")],
  },
  {
    id: D,
    body: D_BODY,
    events: [
      proposed(D, "05-03", "Batch the export"),
      ev(D, "rejected", "05-04", { reason: "no" }),
    ],
  },
];
const NUMBERS = numberingOf({ [A]: 1, [B]: 2 });

describe("fold", () => {
  it.each([
    ["Café", "cafe"],
    ["ﬁle", "file"],
    ["STRASSE", "strasse"],
    ["Straße", "straße"],
    ["Ørsted", "ørsted"],
  ])("%s → %s", (s, f) => {
    expect(fold(s).text).toBe(f);
  });

  it("maps every folded offset back to the original", () => {
    const f = fold("ﬁ Café");
    expect(f.text).toBe("fi cafe");
    expect(f.at).toEqual([0, 0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("searchDecisions", () => {
  it("matches every term in any field, active decisions only, with excerpts", async () => {
    const r = await read(LOG(), { numbering: NUMBERS });
    const doc = searchDecisions(r, { query: "  orders  " });
    expect(doc).toMatchObject({
      format: "adr-search/v1",
      query: "orders",
      terms: ["orders"],
      include_inactive: false,
      total: 1,
      inactive_omitted: 1,
      findings: [],
      notes: [],
    });
    expect(doc.results.map((x) => x.decision.id)).toEqual([B]);
    expect(doc.results[0]).toMatchObject({
      matched: ["title", "body"],
      score: 8,
      excerpt: "Orders, orders, orders and orders.",
      header: { line: `ADR-0002 (${B}) · accepted`, warning: null },
    });
  });

  it("includes inactive decisions on request, ranked and with warnings", async () => {
    const r = await read(LOG(), { numbering: NUMBERS });
    const doc = searchDecisions(r, { query: "orders", includeInactive: true });
    expect(doc.results.map((x) => x.decision.id)).toEqual([B, A]);
    expect(doc.inactive_omitted).toBe(0);
    expect(doc.results[1]?.header.warning).toContain("SUPERSEDED by ADR-0002");
  });

  it("ANDs the terms and folds case and accents", async () => {
    const r = await read(LOG(), { numbering: NUMBERS });
    const ids = (query: string, includeInactive = false) =>
      searchDecisions(r, { query, includeInactive }).results.map((x) => x.decision.id);
    expect(ids("aurora ORDERS")).toEqual([B]);
    expect(ids("aurora dynamodb")).toEqual([]);
    expect(ids("CAFE")).toEqual([C]);
    expect(ids("file team")).toEqual([C]);
    expect(ids("export")).toEqual([]);
    expect(ids("export", true)).toEqual([D]);
  });

  it("finds ids, numbers, titles, bodies without their title line, and notes", async () => {
    const r = await read(LOG(), { numbering: NUMBERS });
    const one = (query: string) => searchDecisions(r, { query, includeInactive: true }).results;
    expect(one(B).map((x) => [x.decision.id, x.matched, x.score])).toEqual([[B, ["id"], 10]]);
    expect(one("adr-0002").map((x) => [x.decision.id, x.score])).toEqual([[B, 10]]);
    expect(one("0001").map((x) => [x.decision.id, x.matched, x.score])).toEqual([[A, ["id"], 0]]);
    expect(one("session").map((x) => [x.matched, x.excerpt])).toEqual([[["title"], null]]);
    expect(one("team").map((x) => [x.matched, x.excerpt])).toEqual([
      [["notes"], "Ask the ﬁle team."],
    ]);
  });

  it("doesn't fold ß to ss", async () => {
    const body = "# Straße\n\nStraße and strasse.\n";
    const r = await read([
      { id: A, body, events: [proposed(A, "03-01", "Straße")] },
      { id: B, body: "# x\n\nSTRASSE\n", events: [proposed(B, "03-02", "x")] },
    ]);
    const ids = (q: string) => searchDecisions(r, { query: q }).results.map((x) => x.decision.id);
    expect(ids("straße")).toEqual([A]);
    expect(ids("strasse")).toEqual([A, B]);
    const only = await read([
      { id: A, body: "# Straße\n", events: [proposed(A, "03-01", "Straße")] },
    ]);
    expect(searchDecisions(only, { query: "strasse" }).total).toBe(0);
  });

  it("breaks score ties by status, then list order, and truncates to limit", async () => {
    const body = (t: string) => `# ${t}\n\nwidget\n`;
    const r = await read(
      [
        { id: D, body: body("d"), events: [proposed(D, "03-01", "d")] },
        { id: C, body: body("c"), events: [proposed(C, "03-02", "c")] },
        {
          id: B,
          body: body("b"),
          events: [proposed(B, "03-03", "b"), accepted(B, "03-04", body("b"))],
        },
      ],
      { numbering: numberingOf({ [B]: 1 }) },
    );
    const all = searchDecisions(r, { query: "widget" });
    expect(all.results.map((x) => x.decision.id)).toEqual([B, D, C]);
    const two = searchDecisions(r, { query: "widget", limit: 2 });
    expect(two.results.map((x) => x.decision.id)).toEqual([B, D]);
    expect(two.total).toBe(3);
  });

  it("cuts long lines to a window around the first hit", async () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const line = `${words} needle ${words}`;
    const r = await read([
      { id: A, body: `# t\n\n${line}\n`, events: [proposed(A, "03-01", "t")] },
    ]);
    const ex = searchDecisions(r, { query: "needle" }).results[0]?.excerpt ?? "";
    expect(ex.startsWith("…")).toBe(true);
    expect(ex.endsWith("…")).toBe(true);
    expect(ex).toContain("needle");
    expect(ex.length).toBeLessThanOrEqual(162);
    expect(ex.slice(1, -1)).toMatch(/^word\d+ .* word\d+$/);
    const start = await read([
      { id: A, body: `# t\n\nneedle ${words}\n`, events: [proposed(A, "03-01", "t")] },
    ]);
    const head = searchDecisions(start, { query: "needle" }).results[0]?.excerpt ?? "";
    expect(head.startsWith("needle ")).toBe(true);
    expect(head.endsWith("…")).toBe(true);
  });

  it("picks the line with the most terms", async () => {
    const body = "# t\n\nalpha only\nalpha and beta\nalpha and beta again\n";
    const r = await read([{ id: A, body, events: [proposed(A, "03-01", "t")] }]);
    expect(searchDecisions(r, { query: "alpha beta" }).results[0]?.excerpt).toBe("alpha and beta");
  });

  it("adds the sources note", async () => {
    const r = await read(LOG(), { sources: ["platform"] });
    expect(searchDecisions(r, { query: "orders" }).notes).toEqual([
      "only this repository's decision log is read; the logs in [[sources]] (platform) aren't listed or searched until ark's step 4",
    ]);
  });

  it.each([
    ["", "1 to 200 characters"],
    ["   ", "1 to 200 characters"],
    ["x".repeat(201), "1 to 200 characters"],
    ["a\tb", "without control characters"],
    ["a b c d e f g h i j k", "at most 10 words"],
  ])("refuses the query %j", async (query, message) => {
    const r = await read(LOG());
    expect(() => searchDecisions(r, { query })).toThrow(UsageError);
    expect(() => searchDecisions(r, { query })).toThrow(message);
  });

  it("refuses a bad limit", async () => {
    const r = await read(LOG());
    expect(() => searchDecisions(r, { query: "x", limit: 0 })).toThrow(UsageError);
  });

  it("returns exactly the decisions whose fields hold every term", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAdrHistory({ subjects: { min: 1, max: 4 }, maxSteps: 12 }),
        fc.string({ minLength: 1, maxLength: 3 }).filter((s) => fold(s).text.trim() !== ""),
        fc.boolean(),
        async (h, raw, includeInactive) => {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: queries refuse them
          fc.pre(!/[\u0000-\u001f\u007f]/.test(raw));
          const r = await readDecisionsFrom(new MemoryTree(h.files), {
            layout: LAYOUT,
            adr: DEFAULT_ADR_CONFIG,
            numbering: NO_NUMBERING,
          });
          const doc = searchDecisions(r, { query: raw, includeInactive });
          const decoder = new TextDecoder();
          const fields = (id: string) => {
            const v = r.projection.views.get(id);
            const loaded = r.folded.subjects.get(id);
            const body = loaded?.loaded?.body?.bytes;
            const text = body === undefined ? "" : decoder.decode(body).replace(/\r\n/g, "\n");
            const lines = text.split("\n");
            const t = lines.findIndex((l) => l.startsWith("# "));
            if (t >= 0) lines.splice(t, 1);
            const notes = (loaded?.applied ?? [])
              .filter((a) => a.event.type === "noted")
              .map((a) => String((a.event.data as { text: string }).text));
            return [
              v?.id ?? "",
              v?.display ?? "",
              v?.title ?? "",
              lines.join("\n"),
              notes.join("\n"),
            ].map((f) => fold(f).text);
          };
          const matches = (id: string) =>
            doc.terms.every((term) => fields(id).some((f) => f.includes(term)));
          const listed = new Set(doc.results.map((x) => x.decision.id));
          for (const v of r.projection.views.values()) {
            const active = v.status === "proposed" || v.status === "accepted";
            expect(listed.has(v.id), v.id).toBe(matches(v.id) && (includeInactive || active));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
