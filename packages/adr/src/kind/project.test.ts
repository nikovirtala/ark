import { NO_NUMBERING, type Numbering, projectLog } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { adrKind, formatDecisionNumber, parseDecisionNumber } from "../kind.js";
import {
  decisionEvent,
  decisionFiles,
  foldFiles,
  hashOf,
  proposedData,
  type SubjectSpec,
} from "../test-support/events.js";

const A = "a7c2m9xd";
const B = "k3f9q8a1";
const C = "m2x7p4d2";
const BODY = "# Decision\n";

const numbering = (byId: Record<string, number>): Numbering => ({
  available: true,
  reason: null,
  ref: "refs/heads/main",
  commit: null,
  byId: new Map(Object.entries(byId)),
  byNumber: new Map(Object.entries(byId).map(([id, n]) => [n, id])),
});

async function views(subjects: SubjectSpec[], n: Numbering = NO_NUMBERING) {
  const files = decisionFiles(subjects);
  return projectLog(adrKind, await foldFiles(files), { numbering: n }).views;
}

const at = (d: string) => `2026-${d}T10:00:00Z`;
const proposed = (id: string, d: string, supersedes?: string[]) =>
  decisionEvent(id, "proposed", { data: proposedData(`Decision ${id}`, supersedes), at: at(d) });
const accepted = (id: string, d: string, body = BODY) =>
  decisionEvent(id, "accepted", { data: { body_sha256: hashOf(body) }, at: at(d) });
const superseded = (id: string, by: string, d: string) =>
  decisionEvent(id, "superseded", { data: { by }, at: at(d) });

describe("project", () => {
  it("follows the supersession chain to the effective decision", async () => {
    const v = await views(
      [
        {
          id: A,
          body: BODY,
          slug: "a",
          events: [proposed(A, "03-12"), accepted(A, "03-14"), superseded(A, B, "05-01")],
        },
        {
          id: B,
          body: BODY,
          events: [proposed(B, "04-01", [A]), accepted(B, "05-01"), superseded(B, C, "06-01")],
        },
        { id: C, body: BODY, events: [proposed(C, "05-20", [B]), accepted(C, "06-01")] },
      ],
      numbering({ [A]: 1, [B]: 2, [C]: 3 }),
    );
    expect(v.get(A)).toEqual({
      id: A,
      number: 1,
      display: "ADR-0001",
      title: `Decision ${A}`,
      status: "superseded",
      superseded_by: B,
      supersedes: [],
      declared_supersedes: [],
      effective: C,
      chain: [A, B, C],
      template: { name: "nygard", version: 1 },
      body_path: `docs/adr/decisions/${A}-a.md`,
      body_sha256: hashOf(BODY),
      body_intact: true,
      links: [],
      applies_to: [],
      notes: 0,
      proposed_at: at("03-12"),
      decided_at: at("03-14"),
      status_at: at("05-01"),
      history: ["proposed 2026-03-12", "accepted 2026-03-14", "superseded 2026-05-01"],
    });
    expect(v.get(B)).toMatchObject({
      supersedes: [A],
      declared_supersedes: [A],
      chain: [B, C],
      effective: C,
    });
    expect(v.get(C)).toMatchObject({
      supersedes: [B],
      chain: [C],
      effective: C,
      superseded_by: null,
    });
  });

  it("reports an edited accepted body and leaves proposals unhashed", async () => {
    const v = await views([
      { id: A, body: "# Edited\n", events: [proposed(A, "03-12"), accepted(A, "03-14")] },
      { id: B, body: BODY, events: [proposed(B, "03-12")] },
    ]);
    expect(v.get(A)).toMatchObject({ body_intact: false, body_sha256: hashOf(BODY) });
    expect(v.get(B)).toMatchObject({
      body_intact: null,
      body_sha256: null,
      number: null,
      display: B,
    });
    expect(v.get(B)?.body_path).toBe(`docs/adr/decisions/${B}.md`);
  });

  it("numbers only decisions whose acceptance applies in this tree", async () => {
    const v = await views(
      [{ id: A, body: BODY, events: [proposed(A, "03-12")] }],
      numbering({ [A]: 4 }),
    );
    expect(v.get(A)).toMatchObject({ number: null, display: A });
  });

  it("collects notes, links and the latest scope", async () => {
    const v = await views([
      {
        id: A,
        body: BODY,
        events: [
          proposed(A, "03-12"),
          decisionEvent(A, "noted", { data: { text: "x" }, at: at("03-13") }),
          decisionEvent(A, "linked", { data: { to: B, rel: "refines" }, at: at("03-13") }),
          decisionEvent(A, "linked", { data: { to: B, rel: "refines" }, at: at("03-14") }),
          decisionEvent(A, "scoped", { data: { set: ["src/**"] }, at: at("03-14") }),
          decisionEvent(A, "scoped", { data: { set: ["docs/**", "infra/*.tf"] }, at: at("03-15") }),
          decisionEvent(A, "withdrawn", { at: at("03-16") }),
        ],
      },
      { id: B, body: BODY, events: [proposed(B, "03-12")] },
    ]);
    expect(v.get(A)).toMatchObject({
      status: "withdrawn",
      notes: 1,
      links: [{ to: B, rel: "refines" }],
      applies_to: ["docs/**", "infra/*.tf"],
      decided_at: at("03-16"),
      status_at: at("03-16"),
      history: ["proposed 2026-03-12", "withdrawn 2026-03-16"],
    });
  });

  it("terminates on a cycle with effective null", async () => {
    const v = await views([
      {
        id: A,
        body: BODY,
        events: [proposed(A, "03-12"), accepted(A, "03-13"), superseded(A, B, "03-14")],
      },
      {
        id: B,
        body: BODY,
        events: [proposed(B, "03-12"), accepted(B, "03-13"), superseded(B, A, "03-14")],
      },
    ]);
    expect(v.get(A)).toMatchObject({ chain: [A, B], effective: null });
    expect(v.get(B)).toMatchObject({ chain: [B, A], effective: null });
  });
});

describe("decision numbers", () => {
  it("formats with at least four digits", () => {
    expect(formatDecisionNumber(7)).toBe("ADR-0007");
    expect(formatDecisionNumber(12345)).toBe("ADR-12345");
  });

  it.each([
    ["7", 7],
    ["0007", 7],
    ["ADR-7", 7],
    ["adr-0007", 7],
    ["ADR0012", 12],
    [" 3 ", 3],
    ["0", null],
    ["ADR-", null],
    ["-7", null],
    ["7a", null],
    ["a7c2m9xd", null],
    ["1234567890", null],
  ] as const)("parses %j as %j", (input, n) => {
    expect(parseDecisionNumber(input)).toBe(n);
  });

  it("round-trips formatted numbers", () => {
    for (const n of [1, 9, 10, 9999, 10000, 123456789]) {
      expect(parseDecisionNumber(formatDecisionNumber(n))).toBe(n);
    }
  });
});
