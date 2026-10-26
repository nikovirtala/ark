import {
  assignNumbers,
  foldLog,
  foldSubject,
  type LoadedSubject,
  loadLog,
  MemoryTree,
  NO_NUMBERING,
  parseEventYaml,
  projectLog,
  serializeEvent,
} from "@nikovirtala/ledger";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { issueGraph, issueKind } from "../kind.js";
import { COMPILED } from "../test-support/events.js";
import { arbIssueHistory, HISTORY_LAYOUT, type IssueHistory } from "../test-support/history.js";

const RUNS = { numRuns: 150, endOnFailure: true } as const;
const weighted = arbIssueHistory({ subjects: { min: 2, max: 8 }, links: true, duplicates: true });

const snapshotOf = (h: IssueHistory) =>
  loadLog(new MemoryTree(h.files), { kind: COMPILED, layout: HISTORY_LAYOUT });

describe("invariants", () => {
  it("every issue has exactly one applied opened event, first", async () => {
    await fc.assert(
      fc.asyncProperty(weighted, async (h) => {
        const log = foldLog(issueKind, await snapshotOf(h));
        for (const s of log.subjects.values()) {
          const opened = s.applied.filter((a) => a.event.type === "opened");
          expect(opened).toHaveLength(1);
          expect(s.applied[0]?.event.type).toBe("opened");
        }
      }),
      RUNS,
    );
  });

  it("no duplicate points at a duplicate; graphs are acyclic; canonical is one step", async () => {
    await fc.assert(
      fc.asyncProperty(weighted, async (h) => {
        const log = foldLog(issueKind, await snapshotOf(h));
        const views = projectLog(issueKind, log, { numbering: NO_NUMBERING }).views;
        expect(issueGraph(log).cycles).toEqual([]);
        for (const v of views.values()) {
          if (v.duplicate_of !== null) {
            expect(views.get(v.duplicate_of)?.duplicate_of ?? null).toBeNull();
          }
          expect(v.canonical).not.toBeNull();
          expect([v.id, v.duplicate_of]).toContain(v.canonical);
        }
      }),
      RUNS,
    );
  });

  it("appending events never changes a number already assigned", () => {
    fc.assert(
      fc.property(arbIssueHistory(), (h) => {
        const on = issueKind.def.numbering?.on ?? "opened";
        // One commit per step, in generation order, as if each landed on main in turn.
        const additions = h.steps.map((s, i) => ({ path: s.path, commit: `c${i}` }));
        const all = assignNumbers(additions, { layout: HISTORY_LAYOUT, on });
        for (let k = 0; k < additions.length; k++) {
          const prefix = assignNumbers(additions.slice(0, k), { layout: HISTORY_LAYOUT, on });
          for (const [id, n] of prefix) expect(all.get(id)).toBe(n);
        }
        expect([...all.values()].sort((a, b) => a - b)).toEqual(h.subjects.map((_, i) => i + 1));
      }),
      RUNS,
    );
  });
});

describe("order independence", () => {
  it("folds, projects and finds the same for every permutation of what the fold receives", async () => {
    await fc.assert(
      fc.asyncProperty(weighted, fc.gen(), async (h, g) => {
        const snap = await snapshotOf(h);
        const entries = g(fc.shuffledSubarray, [...snap.subjects], {
          minLength: snap.subjects.size,
          maxLength: snap.subjects.size,
        });
        const permuted = new Map(
          entries.map(([id, s]): [string, LoadedSubject] => [
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
          expect(strip(foldSubject(issueKind, s))).toEqual(strip(foldSubject(issueKind, original)));
        }
        const fold = (subjects: ReadonlyMap<string, LoadedSubject>) =>
          foldLog(issueKind, { ...snap, subjects });
        const a = fold(permuted);
        const b = fold(snap.subjects);
        expect(projectLog(issueKind, a, { numbering: NO_NUMBERING })).toEqual(
          projectLog(issueKind, b, { numbering: NO_NUMBERING }),
        );
        const kindFindings = (log: typeof a) => [
          ...[...log.subjects.values()].flatMap((s) =>
            s.status === null ? [] : (issueKind.def.invariants?.(s, issueKind.def.options) ?? []),
          ),
          ...(issueKind.def.relate?.(log, issueKind.def.options) ?? []),
        ];
        const sortKey = (fs: ReturnType<typeof kindFindings>) =>
          fs.map((f) => JSON.stringify(f)).sort();
        expect(sortKey(kindFindings(a))).toEqual(sortKey(kindFindings(b)));
      }),
      RUNS,
    );
  });
});

describe("event round trips", () => {
  it("serializeEvent then parseEventYaml returns every generated event", () => {
    fc.assert(
      fc.property(arbIssueHistory({ links: true, duplicates: true }), (h) => {
        for (const { path, event } of h.steps) {
          const r = parseEventYaml(serializeEvent(event), { file: path });
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.doc).toEqual(event);
          expect(COMPILED.validate(event, { file: path }).ok).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
