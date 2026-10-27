import type { EventEnvelope } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { adrKind } from "../kind.js";
import { TEST_AGENT } from "../test-support/decision-arbs.js";
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
const MISSING = "r4tw9xd1";
const BODY = "# Decision\n";

// Fixed times per type, so the fold order doesn't depend on the order the events are built in.
const proposed = (id: string, supersedes?: string[]) =>
  decisionEvent(id, "proposed", {
    data: proposedData(`Decision ${id}`, supersedes),
    at: "2026-03-12T10:00:00Z",
  });
const accepted = (id: string, actor = undefined as EventEnvelope["actor"] | undefined) =>
  decisionEvent(id, "accepted", {
    data: { body_sha256: hashOf(BODY) },
    at: "2026-03-13T10:00:00Z",
    ...(actor === undefined ? {} : { actor }),
  });
const superseded = (id: string, by: string) =>
  decisionEvent(id, "superseded", { data: { by }, at: "2026-03-14T10:00:00Z" });
const subject = (id: string, ...events: EventEnvelope[]): SubjectSpec => ({
  id,
  body: BODY,
  events,
});

async function relateOf(...subjects: SubjectSpec[]) {
  const log = await foldFiles(decisionFiles(subjects));
  return adrKind.def.relate?.(log, adrKind.def.options) ?? [];
}

describe("invariants", () => {
  it("reports an agent acceptance under the human policy, on the accepted event", async () => {
    const e = accepted(A, TEST_AGENT);
    const log = await foldFiles(decisionFiles([subject(A, proposed(A), e)]));
    const s = log.subjects.get(A);
    if (s === undefined) throw new Error("not folded");
    expect(adrKind.def.invariants?.(s, { acceptRequiresHuman: true, sources: null })).toEqual([
      {
        severity: "error",
        rule: "decision/agent-accepted",
        message: "accepted by agent test-agent; accept_requires_human needs a human",
        subject: A,
        event: e.id,
      },
    ]);
    expect(adrKind.def.invariants?.(s, { acceptRequiresHuman: false, sources: null })).toEqual([]);
  });

  it("accepts a human acceptance and an agent proposal", async () => {
    const p = decisionEvent(A, "proposed", { data: proposedData("x"), actor: TEST_AGENT });
    const log = await foldFiles(decisionFiles([subject(A, p, accepted(A))]));
    const s = log.subjects.get(A);
    if (s === undefined) throw new Error("not folded");
    expect(adrKind.def.invariants?.(s, adrKind.def.options)).toEqual([]);
  });
});

describe("relate", () => {
  it("checks qualified references against known sources, and skips them without sources", async () => {
    const link = (to: string, at: string) =>
      decisionEvent(A, "linked", { data: { to, rel: "relates-to" }, at });
    const p = proposed(B, [`gone:${MISSING}`]);
    const s = superseded(C, `uncached:${MISSING}`);
    const subjects = [
      subject(
        A,
        proposed(A),
        link(`platform:${B}`, "2026-03-14T10:00:00Z"),
        link(`platform:${MISSING}`, "2026-03-15T10:00:00Z"),
      ),
      subject(B, p),
      subject(C, proposed(C), accepted(C), s),
    ];
    const log = await foldFiles(decisionFiles(subjects));
    expect(adrKind.def.relate?.(log, adrKind.def.options)).toEqual([]);
    const sources = new Map([
      [
        "platform",
        {
          commit: "c".repeat(40),
          subjects: new Map([
            [B, { status: "accepted" as const, display: "ADR-0001", title: "B" }],
          ]),
        },
      ],
      ["uncached", { commit: null, subjects: null }],
    ]);
    const fs = adrKind.def.relate?.(log, { acceptRequiresHuman: true, sources }) ?? [];
    expect(fs.map((f) => [f.rule, f.subject, f.message])).toEqual([
      [
        "decision/reference-missing",
        A,
        `links to platform:${MISSING}, which is not in source platform at ${"c".repeat(12)}`,
      ],
      [
        "decision/unknown-source",
        B,
        `supersedes gone:${MISSING}, whose source gone isn't in [[sources]]`,
      ],
    ]);
  });

  it("finds nothing in a consistent log", async () => {
    expect(
      await relateOf(
        subject(A, proposed(A), accepted(A), superseded(A, B)),
        subject(B, proposed(B, [A]), accepted(B)),
      ),
    ).toEqual([]);
  });

  it("reports references to subjects that aren't in the log", async () => {
    const link = decisionEvent(A, "linked", {
      data: { to: MISSING, rel: "refines" },
      at: "2026-03-14T10:00:00Z",
    });
    const p = proposed(B, [MISSING]);
    const s = superseded(C, MISSING);
    const fs = await relateOf(
      subject(A, proposed(A), link),
      subject(B, p),
      subject(C, proposed(C), accepted(C), s),
    );
    expect(fs.map((f) => [f.rule, f.subject, f.event, f.related, f.message])).toEqual([
      [
        "decision/reference-missing",
        A,
        link.id,
        [MISSING],
        `links to ${MISSING}, which is not in the log`,
      ],
      [
        "decision/reference-missing",
        B,
        p.id,
        [MISSING],
        `supersedes ${MISSING}, which is not in the log`,
      ],
      [
        "decision/reference-missing",
        C,
        s.id,
        [MISSING],
        `superseded by ${MISSING}, which is not in the log`,
      ],
    ]);
  });

  it("skips qualified references in phase 1", async () => {
    const link = decisionEvent(A, "linked", { data: { to: `other:${MISSING}`, rel: "refines" } });
    expect(
      await relateOf(
        subject(A, proposed(A, [`other:${B}`]), accepted(A), link, superseded(A, `other:${C}`)),
      ),
    ).toEqual([]);
  });

  it("reports a supersession by a decision that isn't accepted", async () => {
    const s = superseded(A, B);
    const fs = await relateOf(subject(A, proposed(A), accepted(A), s), subject(B, proposed(B)));
    expect(fs).toEqual([
      {
        severity: "error",
        rule: "decision/superseded-by-unaccepted",
        message: `superseded by ${B}, which is not accepted`,
        subject: A,
        event: s.id,
        related: [B],
      },
    ]);
  });

  it("reports a supersession cycle once, on its smallest id, even on corrupt data", async () => {
    const sa = superseded(A, B);
    const fs = await relateOf(
      subject(A, proposed(A), accepted(A), sa),
      subject(B, proposed(B), accepted(B), superseded(B, C)),
      subject(C, proposed(C), accepted(C), superseded(C, A)),
    );
    expect(fs).toEqual([
      {
        severity: "error",
        rule: "decision/supersession-cycle",
        message: `supersession cycle: ${A} → ${B} → ${C} → ${A}`,
        subject: A,
        event: sa.id,
        related: [A, B, C],
      },
    ]);
  });

  it("reports a self-supersession as a cycle", async () => {
    const fs = await relateOf(subject(A, proposed(A), accepted(A), superseded(A, A)));
    expect(fs.map((f) => [f.rule, f.message])).toEqual([
      ["decision/supersession-cycle", `supersession cycle: ${A} → ${A}`],
    ]);
  });
});
