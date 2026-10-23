import { MemoryTree, NO_NUMBERING, type Numbering, UsageError } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADR_CONFIG } from "./config.js";
import { readDecisionsFrom, resolveDecision } from "./log.js";
import {
  decisionEvent,
  decisionFiles,
  hashOf,
  LAYOUT,
  numberingOf,
  proposedData,
  type SubjectSpec,
} from "./test-support/events.js";
import { listDecisions, showDecision, stateHeader } from "./views.js";

const A = "a7c2m9xd";
const B = "k3f9q8a1";
const C = "m2x7p4d2";
const D = "r4tw9xd1";
const E = "zz9e4w2q";
const BODY = "# Decision\n\nText.\n";

const at = (d: string) => `2026-${d}T10:00:00Z`;
const ev = (id: string, type: string, d: string, o: Record<string, unknown> = {}) =>
  decisionEvent(id, type, { at: at(d), ...o });
const proposed = (id: string, d: string, title = `Decision ${id}`) =>
  ev(id, "proposed", d, { data: proposedData(title) });
const accepted = (id: string, d: string) =>
  ev(id, "accepted", d, { data: { body_sha256: hashOf(BODY) } });

function read(subjects: SubjectSpec[], numbering: Numbering = NO_NUMBERING, extra = {}) {
  return readDecisionsFrom(new MemoryTree({ ...decisionFiles(subjects), ...extra }), {
    layout: LAYOUT,
    adr: DEFAULT_ADR_CONFIG,
    numbering,
  });
}

/** A superseded by B superseded by C; D deprecated; E rejected. */
const chainLog = (): SubjectSpec[] => [
  {
    id: A,
    body: BODY,
    slug: "use-dynamodb",
    events: [
      proposed(A, "03-12", "Use DynamoDB"),
      accepted(A, "03-14"),
      ev(A, "superseded", "05-01", { data: { by: B } }),
    ],
  },
  {
    id: B,
    body: BODY,
    events: [
      proposed(B, "04-01"),
      accepted(B, "05-01"),
      ev(B, "superseded", "06-02", { data: { by: C } }),
    ],
  },
  { id: C, body: BODY, events: [proposed(C, "05-20"), accepted(C, "06-01")] },
  {
    id: D,
    body: BODY,
    events: [
      proposed(D, "02-01"),
      accepted(D, "02-02"),
      ev(D, "deprecated", "07-04", { reason: "the service is gone" }),
    ],
  },
  {
    id: E,
    body: BODY,
    events: [proposed(E, "01-01"), ev(E, "rejected", "01-05", { reason: "too costly" })],
  },
];

describe("stateHeader", () => {
  it("leads a superseded decision with the effective one and the chain", async () => {
    const r = await read(chainLog(), numberingOf({ [A]: 2, [B]: 3, [C]: 4, [D]: 1 }));
    const view = r.projection.views.get(A);
    if (view === undefined) throw new Error("no view");
    expect(stateHeader(view, r)).toEqual({
      line: `ADR-0002 (${A}) · superseded`,
      warning:
        "SUPERSEDED by ADR-0004 (accepted 2026-06-01). Do not apply this decision; read ADR-0004 instead. Chain: ADR-0002 → ADR-0003 → ADR-0004.",
    });
    expect(
      stateHeader(view, r, {
        refer: (id) => `adr://decision/${r.projection.views.get(id)?.display ?? id}`,
      }).warning,
    ).toBe(
      "SUPERSEDED by ADR-0004 (accepted 2026-06-01). Do not apply this decision; read adr://decision/ADR-0004 instead. Chain: ADR-0002 → ADR-0003 → ADR-0004.",
    );
    const b = r.projection.views.get(B);
    if (b === undefined) throw new Error("no view");
    expect(stateHeader(b, r).warning).toBe(
      "SUPERSEDED by ADR-0004 (accepted 2026-06-01). Do not apply this decision; read ADR-0004 instead.",
    );
  });

  it("uses ids when unnumbered", async () => {
    const r = await read(chainLog());
    const view = r.projection.views.get(B);
    if (view === undefined) throw new Error("no view");
    expect(stateHeader(view, r)).toEqual({
      line: `${B} · superseded`,
      warning: `SUPERSEDED by ${C} (accepted 2026-06-01). Do not apply this decision; read ${C} instead.`,
    });
  });

  it("says deprecated and rejected decisions are not in force, with their reason", async () => {
    const r = await read(chainLog(), numberingOf({ [D]: 1 }));
    const header = (id: string) => {
      const v = r.projection.views.get(id);
      if (v === undefined) throw new Error("no view");
      return stateHeader(v, r);
    };
    expect(header(D)).toEqual({
      line: `ADR-0001 (${D}) · deprecated`,
      warning: "DEPRECATED on 2026-07-04: the service is gone. No decision replaces it.",
    });
    expect(header(E)).toEqual({
      line: `${E} · rejected`,
      warning: "REJECTED on 2026-01-05: too costly. This decision was never in force.",
    });
    expect(header(C)).toEqual({ line: `${C} · accepted`, warning: null });
  });

  it("words withdrawn decisions with and without a reason", async () => {
    const r = await read([
      { id: A, body: BODY, events: [proposed(A, "03-01"), ev(A, "withdrawn", "03-02")] },
      {
        id: B,
        body: BODY,
        events: [proposed(B, "03-01"), ev(B, "withdrawn", "03-03", { reason: "duplicate" })],
      },
      { id: C, body: BODY, events: [proposed(C, "03-01")] },
    ]);
    const warning = (id: string) => {
      const v = r.projection.views.get(id);
      if (v === undefined) throw new Error("no view");
      return stateHeader(v, r).warning;
    };
    expect(warning(A)).toBe("WITHDRAWN on 2026-03-02. This decision was never in force.");
    expect(warning(B)).toBe(
      "WITHDRAWN on 2026-03-03: duplicate. This decision was never in force.",
    );
    expect(warning(C)).toBeNull();
  });

  it("warns about a body edited after acceptance", async () => {
    const r = await read([
      { id: A, body: "# Edited\n", events: [proposed(A, "03-01"), accepted(A, "03-02")] },
    ]);
    const v = r.projection.views.get(A);
    if (v === undefined) throw new Error("no view");
    expect(stateHeader(v, r).warning).toBe(
      "WARNING: the body changed after acceptance; run adr verify.",
    );
  });
});

describe("listDecisions", () => {
  it("orders numbered decisions by number, then the rest by proposal time and id", async () => {
    const r = await read(
      [...chainLog(), { id: "b0000000", body: BODY, events: [proposed("b0000000", "01-01")] }],
      numberingOf({ [A]: 2, [B]: 3, [C]: 4, [D]: 1 }),
    );
    const list = listDecisions(r);
    expect(list.decisions.map((d) => d.id)).toEqual([D, A, B, C, "b0000000", E]);
    expect(
      listDecisions(r, { status: ["superseded", "rejected"] }).decisions.map((d) => d.id),
    ).toEqual([A, B, E]);
    expect(listDecisions(r, { limit: 2 }).decisions.map((d) => d.id)).toEqual([D, A]);
  });

  it("builds the adr-list/v1 document with unreadable and unfoldable subjects", async () => {
    const orphan = `docs/adr/decisions/${D}.md`;
    const notInitial = ev(C, "accepted", "03-01", { data: { body_sha256: hashOf(BODY) } });
    const r = await read(
      [
        { id: A, body: BODY, events: [proposed(A, "03-01")] },
        { id: C, body: BODY, events: [notInitial] },
      ],
      NO_NUMBERING,
      {
        [orphan]: BODY,
        [`docs/adr/events/${E}/20260301T100000Z-abcd-proposed.yaml`]:
          "envelope: ledger/v9\nkind: decision\n",
      },
    );
    const list = listDecisions(r);
    expect(Object.keys(list)).toEqual([
      "format",
      "root",
      "ref",
      "commit",
      "numbering",
      "decisions",
      "unreadable",
      "unfoldable",
      "findings",
      "notes",
    ]);
    expect(list).toMatchObject({
      format: "adr-list/v1",
      root: "docs/adr",
      ref: null,
      commit: null,
      numbering: { available: false, reason: "no-main-ref", ref: null },
      unreadable: [E],
      unfoldable: [C, D],
      notes: [],
    });
    expect(list.decisions.map((d) => d.id)).toEqual([A]);
    // Findings of decisions that aren't listed (C, D, E) are left out.
    expect(list.findings).toEqual([]);
    expect(r.findings.map((f) => [f.rule, f.subject])).toEqual([
      ["transition/no-events", D],
      ["transition/not-initial", C],
      ["envelope/unknown-version", E],
    ]);
  });
});

describe("showDecision", () => {
  it("builds the adr-show/v1 document", async () => {
    const r = await read(chainLog(), numberingOf({ [A]: 1, [B]: 2, [C]: 3 }));
    const show = await showDecision(r, A);
    expect(Object.keys(show)).toEqual([
      "format",
      "root",
      "ref",
      "commit",
      "numbering",
      "header",
      "decision",
      "body",
      "events",
      "findings",
      "notes",
    ]);
    expect(show).toMatchObject({
      format: "adr-show/v1",
      header: { line: `ADR-0001 (${A}) · superseded` },
      decision: { id: A, title: "Use DynamoDB", effective: C },
      body: BODY,
      events: null,
      findings: [],
      notes: [],
    });
    const history = await showDecision(r, A, { history: true });
    expect(history.events?.map((e) => e.type)).toEqual(["proposed", "accepted", "superseded"]);
  });

  it("refuses unknown, unreadable and unfoldable decisions", async () => {
    const r = await read([{ id: A, body: BODY, events: [proposed(A, "03-01")] }], NO_NUMBERING, {
      [`docs/adr/decisions/${D}.md`]: BODY,
      [`docs/adr/events/${E}/20260301T100000Z-abcd-proposed.yaml`]: "envelope: ledger/v9\n",
    });
    await expect(showDecision(r, B)).rejects.toThrow(new UsageError(`unknown decision ${B}`));
    await expect(showDecision(r, E)).rejects.toThrow(/uses a newer format; upgrade adr/);
    await expect(showDecision(r, D)).rejects.toThrow(/can't be read; run adr verify/);
  });
});

describe("resolveDecision", () => {
  it("resolves ids and numbers in every form", async () => {
    const r = await read(chainLog(), numberingOf({ [A]: 7 }));
    for (const input of [A, ` ${A} `, "7", "0007", "ADR-7", "adr-0007"]) {
      expect(resolveDecision(r, input)).toBe(A);
    }
  });

  it("names the reason when the input names nothing", async () => {
    const r = await read(chainLog(), numberingOf({ [A]: 7 }));
    expect(() => resolveDecision(r, "ADR-0042")).toThrow(
      new UsageError("unknown decision ADR-0042"),
    );
    expect(() => resolveDecision(r, "zzzzzzzz")).toThrow(/^unknown decision zzzzzzzz$/);
    expect(() => resolveDecision(r, `other:${A}`)).toThrow(
      /is in another log; cross-log references arrive in phase 2/,
    );
    expect(() => resolveDecision(r, "")).toThrow(/^invalid decision ""$/);
    const unnumbered = await read(chainLog());
    expect(() => resolveDecision(unnumbered, "7")).toThrow(
      /decision numbers are unavailable \(no main branch\); use the decision's id instead of "7"/,
    );
    expect(() => resolveDecision(unnumbered, "7")).toThrow(UsageError);
  });
});
