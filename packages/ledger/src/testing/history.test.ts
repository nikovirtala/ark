import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { foldLog, foldSubject } from "../fold/fold.js";
import { NO_NUMBERING } from "../fold/numbering.js";
import { projectLog } from "../fold/project.js";
import { MemoryTree } from "../git/tree.js";
import type { AnyKind } from "../kind/types.js";
import type { LoadedSubject, LogSnapshot } from "../log/snapshot.js";
import { loadLog } from "../log/snapshot.js";
import { verifySnapshots } from "../verify/verify.js";
import { exampleMachineKind as kind } from "./example-machine-kind.js";
import {
  arbLegalHistory,
  type DataArbs,
  finalHistoryContext,
  type LegalHistory,
  TEST_HUMAN,
} from "./history.js";

type Widget = typeof kind;

const data: DataArbs<Widget> = {
  created: () => fc.record({ title: fc.string({ minLength: 1, maxLength: 20 }) }),
  noted: () => fc.record({ text: fc.string({ minLength: 1, maxLength: 20 }) }),
  published: () => fc.constant({}),
  retired: () => fc.constant({}),
  revived: () => fc.constant({}),
};
const arbHistory = (o: { maxSteps?: number } = {}) =>
  arbLegalHistory(kind, { data, body: () => fc.string({ maxLength: 80 }), ...o });

async function snapshotOf(h: LegalHistory<Widget>): Promise<LogSnapshot> {
  return loadLog(new MemoryTree(h.files), { kind: compileKind(kind), layout: h.layout });
}

/** The folded shape the reference model predicts; independent of `defineKind` and the fold. */
interface RefSubject {
  status: "draft" | "published" | "retired";
  title: string;
  notes: number;
  revivals: number;
  applied: string[];
}

/** A hand-written widget fold over events in the given order. `null` for an illegal step. */
function refStep(r: RefSubject | undefined, e: EventEnvelope): RefSubject | null {
  const applied = [...(r?.applied ?? []), e.id];
  if (r === undefined) {
    return e.type === "created"
      ? { status: "draft", title: String(e.data.title), notes: 0, revivals: 0, applied }
      : null;
  }
  switch (e.type) {
    case "noted":
      return { ...r, notes: r.notes + 1, applied };
    case "published":
      return r.status === "draft" ? { ...r, status: "published", applied } : null;
    case "retired":
      return r.status === "published" ? { ...r, status: "retired", applied } : null;
    case "revived":
      return r.status === "retired"
        ? { ...r, status: "published", revivals: r.revivals + 1, applied }
        : null;
    default:
      return null;
  }
}

/** The reference model over `steps`: these are in `(at, id)` order per subject. */
function referenceFold(h: LegalHistory<Widget>): Map<string, RefSubject> {
  const out = new Map<string, RefSubject>();
  for (const { subject, event } of h.steps) {
    const next = refStep(out.get(subject), event);
    if (next === null) throw new Error(`generated an illegal ${event.type} on ${subject}`);
    out.set(subject, next);
  }
  return out;
}

type FoldFn = (s: LoadedSubject) => { status: string | null; state: unknown; applied: string[] };

const ledgerFold: FoldFn = (s) => {
  const f = foldSubject(kind, s);
  return { status: f.status, state: f.state, applied: f.applied.map((a) => a.event.id) };
};

/** A deliberately wrong fold: events in file-name order, which loadLog already sorts by path. */
const pathSortingFold: FoldFn = (s) => {
  const { machine } = kind as AnyKind;
  let status: string | null = null;
  let state: unknown = null;
  const applied: string[] = [];
  for (const { event } of s.events) {
    if (event === null) continue;
    const allowed =
      status === null ? event.type === machine.initial.type : machine.allowed(status, event.type);
    if (!allowed) continue;
    status = machine.types.get(event.type)?.to ?? status;
    state = kind.def.reduce(state as never, event as never);
    applied.push(event.id);
  }
  return { status, state, applied };
};

/** The fold equals the reference fold over `steps` for every subject. */
const matchesReference = (foldFn: FoldFn) =>
  fc.asyncProperty(arbHistory(), async (h) => {
    const snap = await snapshotOf(h);
    const ref = referenceFold(h);
    expect([...snap.subjects.keys()].sort()).toEqual([...ref.keys()].sort());
    for (const [id, r] of ref) {
      const s = snap.subjects.get(id);
      if (s === undefined) throw new Error(`${id} not loaded`);
      expect(foldFn(s)).toEqual({
        status: r.status,
        state: { title: r.title, notes: r.notes, revivals: r.revivals },
        applied: r.applied,
      });
    }
  });

describe("arbLegalHistory", () => {
  it("generates histories that fold and verify with no findings", async () => {
    await fc.assert(
      fc.asyncProperty(arbHistory(), async (h) => {
        const snap = await snapshotOf(h);
        const log = foldLog(kind, snap);
        expect(snap.structural).toEqual([]);
        for (const s of log.subjects.values()) {
          expect(s.status).not.toBeNull();
          expect(s.findings).toEqual([]);
          expect(s.skipped).toEqual([]);
          expect(s.loaded.findings).toEqual([]);
          expect(s.loaded.events.flatMap((e) => e.findings)).toEqual([]);
        }
        const findings = await verifySnapshots({
          kind: compileKind(kind),
          layout: h.layout,
          base: null,
          head: new MemoryTree(h.files),
          scope: "all",
        });
        expect(findings).toEqual([]);
      }),
    );
  });

  it("describes its subjects and steps consistently", () => {
    fc.assert(
      fc.property(arbHistory(), (h) => {
        expect(h.subjects.length).toBeGreaterThanOrEqual(1);
        expect(h.subjects.length).toBeLessThanOrEqual(4);
        expect(h.steps.length).toBeLessThanOrEqual(20);
        const ats = h.steps.map((s) => s.event.at);
        expect(ats).toEqual([...ats].sort());
        expect(ats[0] !== undefined && ats[0] >= "2001-01-01T00:00:00Z").toBe(true);
        for (const s of h.subjects) {
          const steps = h.steps.filter((x) => x.subject === s.id);
          expect(steps[0]?.event.type).toBe("created");
          expect(s.events.map((e) => e.path)).toEqual(steps.map((x) => x.path).sort());
          expect(s.bodyPath).not.toBeNull();
          expect(s.frozen).toBe(steps.some((x) => x.event.type === "published"));
          for (const e of steps) {
            expect(e.event.actor).toEqual(TEST_HUMAN);
            expect(e.event.type !== "retired" || (e.event.reason ?? "").trim() !== "").toBe(true);
          }
        }
      }),
    );
  });

  it("produces same-second events whose file order differs from fold order", () => {
    const differs = (h: LegalHistory<Widget>) =>
      h.subjects.some((s) => {
        const fold = h.steps.filter((x) => x.subject === s.id).map((x) => x.path);
        return fold.join() !== s.events.map((e) => e.path).join();
      });
    const histories = fc.sample(arbHistory(), { numRuns: 200, seed: 1 });
    expect(histories.some(differs)).toBe(true);
  });

  it("gives same-second events of one type distinct file names", () => {
    // Seed 164 once generated two `noted` events with the same bytes in one second, so the
    // fixture had a duplicate path.
    const arb = arbLegalHistory(kind, { data, body: () => fc.constant(""), ties: 1 });
    for (const h of fc.sample(arb, { numRuns: 100, seed: 164 })) {
      const paths = h.steps.map((s) => s.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it("folds independently of each subject's event order", async () => {
    await fc.assert(
      fc.asyncProperty(arbHistory(), fc.gen(), async (h, g) => {
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
          expect(strip(foldSubject(kind, s))).toEqual(strip(foldSubject(kind, original)));
        }
        const project = (subjects: ReadonlyMap<string, LoadedSubject>) =>
          projectLog(kind, foldLog(kind, { ...snap, subjects }), { numbering: NO_NUMBERING });
        expect(project(permuted)).toEqual(project(snap.subjects));
      }),
    );
  });

  it("folds like the hand-written reference model", async () => {
    await fc.assert(matchesReference(ledgerFold));
  });

  it("catches a fold that orders events by file name", async () => {
    // No shrinking: the point is that a fixed seed finds a counterexample within 100 runs.
    const run = await fc.check(matchesReference(pathSortingFold), {
      seed: 42,
      numRuns: 100,
      endOnFailure: true,
    });
    expect(run.failed).toBe(true);
    const ok = await fc.check(matchesReference(ledgerFold), { seed: 42, numRuns: 100 });
    expect(ok.failed).toBe(false);
  });

  it("stops early when no subject has an applicable type", () => {
    const only: DataArbs<Widget> = { ...data, noted: () => null, published: () => null };
    const histories = fc.sample(
      arbLegalHistory(kind, { data: only, body: () => fc.constant("") }),
      {
        numRuns: 20,
        seed: 3,
      },
    );
    for (const h of histories) {
      expect(h.steps.every((s) => s.event.type === "created")).toBe(true);
    }
  });
});

describe("finalHistoryContext", () => {
  it("answers status and state after the whole history", () => {
    fc.assert(
      fc.property(arbHistory(), (h) => {
        const ref = referenceFold(h);
        const [first] = h.subjects;
        if (first === undefined) throw new Error("no subjects");
        const ctx = finalHistoryContext(h, kind, first.id);
        expect(ctx.subject).toBe(first.id);
        expect(ctx.subjects).toEqual([...new Set(h.steps.map((s) => s.subject))]);
        for (const [id, r] of ref) {
          expect(ctx.status(id)).toBe(r.status);
          expect(ctx.state(id)).toEqual({ title: r.title, notes: r.notes, revivals: r.revivals });
        }
        expect(ctx.status("zzzzzzzz")).toBeNull();
      }),
    );
  });
});
