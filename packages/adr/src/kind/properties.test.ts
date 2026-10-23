import {
  type EventEnvelope,
  type Finding,
  foldChecks,
  foldLog,
  foldSubject,
  type LoadedSubject,
  loadLog,
  MemoryTree,
  NO_NUMBERING,
  projectLog,
  verifySnapshots,
} from "@nikovirtala/ledger";
import {
  applySemanticTamper,
  applyTamper,
  arbSemanticTamper,
  arbTamper,
  expectedRules,
  type SemanticTamper,
  semanticExpectedRules,
} from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { adrKind } from "../kind.js";
import {
  type AdrHistory,
  type AdrTamper,
  adrDataArbs,
  adrExpectedRules,
  adrSupersessionArbs,
  applyAdrTamper,
  arbAdrHistory,
  arbAdrTamper,
} from "../test-support/decision-arbs.js";
import { COMPILED, foldFiles, hashOf } from "../test-support/events.js";

const checks = foldChecks(adrKind, { templates: null });
const scopes = ["all", "changed"] as const;

/**
 * Scope `all` checks the tree alone, unless `withBase`; scope `changed` checks it against the
 * history's files.
 */
function verify(
  h: AdrHistory,
  head: Readonly<Record<string, string>>,
  scope: "all" | "changed",
  withBase = scope === "changed",
): Promise<Finding[]> {
  return verifySnapshots({
    kind: COMPILED,
    layout: h.layout,
    base: withBase ? new MemoryTree(h.files) : null,
    head: new MemoryTree(head),
    scope,
    checks,
  });
}

type Status = "proposed" | "accepted" | "rejected" | "withdrawn" | "deprecated" | "superseded";

/** 01:160–165 by hand: the next status, `"same"`, or absent when the type is illegal. */
const NEXT: Readonly<Record<Status, Readonly<Record<string, Status | "same">>>> = {
  proposed: {
    accepted: "accepted",
    rejected: "rejected",
    withdrawn: "withdrawn",
    noted: "same",
    linked: "same",
    scoped: "same",
  },
  accepted: {
    deprecated: "deprecated",
    superseded: "superseded",
    noted: "same",
    linked: "same",
    scoped: "same",
  },
  deprecated: { superseded: "superseded", noted: "same", linked: "same", scoped: "same" },
  rejected: { noted: "same", linked: "same" },
  withdrawn: { noted: "same", linked: "same" },
  superseded: { noted: "same", linked: "same" },
};
const TERMINAL = new Set(["rejected", "withdrawn", "superseded"]);

interface RefDecision {
  readonly status: Status;
  readonly title: string;
  readonly supersededBy: string | null;
  readonly bodySha256: string | null;
  readonly notes: number;
  readonly applied: readonly string[];
}

/** The reference fold over `steps`, which are in `(at, id)` order per subject. */
function referenceFold(h: AdrHistory): Map<string, RefDecision> {
  const out = new Map<string, RefDecision>();
  for (const { subject, event: e } of h.steps) {
    const r = out.get(subject);
    if (r === undefined) {
      if (e.type !== "proposed") throw new Error(`first event of ${subject} is ${e.type}`);
      out.set(subject, {
        status: "proposed",
        title: String(e.data.title),
        supersededBy: null,
        bodySha256: null,
        notes: 0,
        applied: [e.id],
      });
      continue;
    }
    const to = NEXT[r.status][e.type];
    if (to === undefined) throw new Error(`generated an illegal ${e.type} on ${subject}`);
    out.set(subject, {
      ...r,
      status: to === "same" ? r.status : to,
      supersededBy: e.type === "superseded" ? String(e.data.by) : r.supersededBy,
      bodySha256: e.type === "accepted" ? String(e.data.body_sha256) : r.bodySha256,
      notes: r.notes + (e.type === "noted" ? 1 : 0),
      applied: [...r.applied, e.id],
    });
  }
  return out;
}

const snapshotOf = (h: AdrHistory) =>
  loadLog(new MemoryTree(h.files), { kind: COMPILED, layout: h.layout });

describe("order independence (AC 5)", () => {
  it("folds and projects the same for every permutation of each subject's events", async () => {
    await fc.assert(
      fc.asyncProperty(arbAdrHistory(), fc.gen(), async (h, g) => {
        const snap = await snapshotOf(h);
        const permuted = new Map(
          [...snap.subjects].map(([id, s]): [string, LoadedSubject] => [
            id,
            {
              ...s,
              events: g(fc.shuffledSubarray, [...s.events], {
                minLength: s.events.length,
                maxLength: s.events.length,
              }),
            },
          ]),
        );
        const strip = <T extends { loaded: unknown }>({ loaded: _, ...rest }: T) => rest;
        for (const [id, s] of permuted) {
          const original = snap.subjects.get(id);
          if (original === undefined) throw new Error(`${id} not loaded`);
          expect(strip(foldSubject(adrKind, s))).toEqual(strip(foldSubject(adrKind, original)));
        }
        const project = (subjects: ReadonlyMap<string, LoadedSubject>) =>
          projectLog(adrKind, foldLog(adrKind, { ...snap, subjects }), {
            numbering: NO_NUMBERING,
          });
        expect(project(permuted)).toEqual(project(snap.subjects));
      }),
    );
  });

  it("folds like the hand-written reference model, in (at, id) order", async () => {
    await fc.assert(
      fc.asyncProperty(arbAdrHistory(), async (h) => {
        const log = await foldFiles(h.files);
        const ref = referenceFold(h);
        expect([...log.subjects.keys()].sort()).toEqual([...ref.keys()].sort());
        for (const [id, r] of ref) {
          const s = log.subjects.get(id);
          expect({
            status: s?.status,
            title: s?.state?.title,
            supersededBy: s?.state?.supersededBy,
            bodySha256: s?.state?.bodySha256,
            notes: s?.state?.notes,
            applied: s?.applied.map((a) => a.event.id),
          }).toEqual(r);
        }
      }),
    );
  });
});

describe("invariants over legal histories (AC 7)", () => {
  it("hold for every history built with adr's generators", async () => {
    await fc.assert(
      fc.asyncProperty(arbAdrHistory(), async (h) => {
        expect(await verify(h, h.files, "all")).toEqual([]);
        const log = await foldFiles(h.files);
        const { views } = projectLog(adrKind, log, { numbering: NO_NUMBERING });
        for (const [id, s] of log.subjects) {
          const terminal = s.applied.filter((a) => TERMINAL.has(a.event.type));
          expect(terminal.length).toBeLessThanOrEqual(1);
          const by = s.state?.supersededBy ?? null;
          if (by !== null) {
            const target = log.subjects.get(by);
            expect(target?.applied.some((a) => a.event.type === "accepted")).toBe(true);
          }
          const v = views.get(id);
          expect(v?.effective).not.toBeNull();
          expect(v?.chain.at(-1)).toBe(v?.effective);
          expect(new Set(v?.chain).size).toBe(v?.chain.length);
          if (s.state?.bodySha256 !== null && s.state?.bodySha256 !== undefined) {
            const body = s.loaded.body;
            expect(body === null ? null : hashOf(new TextDecoder().decode(body.bytes))).toBe(
              s.state.bodySha256,
            );
            expect(v?.body_intact).toBe(true);
          }
        }
      }),
    );
  });
});

describe("tamper detection (AC 11)", () => {
  it("finds nothing in an untampered history, in both scopes", async () => {
    await fc.assert(
      fc.asyncProperty(arbAdrHistory(), async (h) => {
        expect(await verify(h, h.files, "all")).toEqual([]);
        expect(await verify(h, h.files, "changed")).toEqual([]);
      }),
    );
  });

  for (const scope of scopes) {
    it(`detects every mechanical tamper guaranteed in scope ${scope}`, async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAdrHistory().chain((h) => fc.tuple(fc.constant(h), arbTamper(h, { scope }))),
          async ([h, m]) => {
            const findings = await verify(h, applyTamper(h.files, m), scope, true);
            const hit = findings.some(
              (f) => f.severity === "error" && expectedRules[m.type].includes(f.rule),
            );
            expect(hit, JSON.stringify({ m, findings }, null, 2)).toBe(true);
          },
        ),
      );
    });
  }

  for (const type of Object.keys(semanticExpectedRules) as SemanticTamper["type"][]) {
    it(`detects the semantic tamper ${type} in both scopes`, async () => {
      await fc.assert(
        fc.asyncProperty(arbAdrHistory(), fc.gen(), async (h, g) => {
          const arb = arbSemanticTamper(h, { kind: adrKind, data: adrDataArbs, only: [type] });
          fc.pre(arb !== null);
          const m = g(() => arb);
          expect(m.type).toBe(type);
          const head = applySemanticTamper(h.files, m);
          for (const scope of scopes) {
            const findings = await verify(h, head, scope);
            const hit = findings.some(
              (f) =>
                f.severity === "error" &&
                semanticExpectedRules[type].includes(f.rule) &&
                f.file === m.path,
            );
            expect(hit, JSON.stringify({ m, findings }, null, 2)).toBe(true);
          }
        }),
      );
    });
  }

  const adrTampers: readonly [AdrTamper["type"], Parameters<typeof arbAdrHistory>[0]][] = [
    ["dangling-superseded-by", { data: adrSupersessionArbs }],
    [
      "supersession-cycle",
      { data: adrSupersessionArbs, subjects: { min: 2, max: 4 }, maxSteps: 30 },
    ],
    ["agent-acceptance", {}],
    ["accepted-body-edited", {}],
  ];
  for (const [type, o] of adrTampers) {
    it(`detects the adr tamper ${type} in both scopes`, async () => {
      await fc.assert(
        fc.asyncProperty(arbAdrHistory(o), fc.gen(), async (h, g) => {
          const arb = arbAdrTamper(h, { only: [type] });
          fc.pre(arb !== null);
          const m = g(() => arb);
          expect(m.type).toBe(type);
          const head = applyAdrTamper(h.files, m);
          for (const scope of scopes) {
            const findings = await verify(h, head, scope);
            const hit = findings.some(
              (f) => f.severity === "error" && adrExpectedRules[type].includes(f.rule),
            );
            expect(hit, JSON.stringify({ m, findings }, null, 2)).toBe(true);
            if (type === "supersession-cycle" && scope === "all") {
              expect(findings.map((f) => f.rule)).toEqual(["decision/supersession-cycle"]);
            }
          }
        }),
      );
    });
  }

  it("has no adr tamper candidate without accepted decisions", () => {
    const h = fc.sample(arbAdrHistory({ maxSteps: 1 }), { numRuns: 20, seed: 5 });
    for (const x of h) {
      const events: EventEnvelope[] = x.steps.map((s) => s.event);
      expect(events.every((e) => e.type === "proposed")).toBe(true);
      expect(arbAdrTamper(x)).toBe(null);
    }
  });
});
