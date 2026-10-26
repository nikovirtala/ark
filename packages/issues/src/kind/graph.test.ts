import {
  type EventEnvelope,
  type FoldedLogOf,
  foldLog,
  loadLog,
  MemoryTree,
  NO_NUMBERING,
  projectLog,
} from "@nikovirtala/ledger";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { issueGraph, issueKind } from "../kind.js";
import {
  COMPILED,
  foldFiles,
  IDS,
  issueEvent,
  issueFiles,
  opened,
  type SubjectSpec,
} from "../test-support/events.js";
import { arbIssueHistory, HISTORY_LAYOUT } from "../test-support/history.js";

const { A, B, C, D, Z } = IDS;

const closed = (id: string, resolution: string, of?: string) =>
  issueEvent(id, "closed", {
    data: { resolution, ...(of === undefined ? {} : { of }) },
    reason: "because",
  });
const linked = (id: string, to: string, rel: string) =>
  issueEvent(id, "linked", { data: { to, rel } });
const subject = (id: string, ...events: EventEnvelope[]): SubjectSpec => ({ id, events });
const logOf = (...s: SubjectSpec[]): Promise<FoldedLogOf<typeof issueKind>> =>
  foldFiles(issueFiles(s));

describe("derived fields, every kind of target", () => {
  const source = (to: string, rel: string) => subject(A, opened(A), linked(A, to, rel));

  it("an open target: listed, blocks, not ready", async () => {
    const dep = issueGraph(await logOf(source(B, "depends-on"), subject(B, opened(B))));
    expect(dep.fields(A)).toMatchObject({
      depends_on: [B],
      blocked_by_open: [B],
      blocked: true,
      ready: false,
    });
    expect(dep.fields(B)).toMatchObject({ blocks: [A], ready: true });
    const part = issueGraph(await logOf(source(B, "part-of"), subject(B, opened(B))));
    expect(part.fields(A)).toMatchObject({ parent: B, ready: true });
    expect(part.fields(B)).toMatchObject({ children: [A], ready: false });
  });

  for (const resolution of ["done", "wontfix", "obsolete"]) {
    it(`a target closed as ${resolution}: listed, doesn't block`, async () => {
      const g = issueGraph(
        await logOf(source(B, "depends-on"), subject(B, opened(B), closed(B, resolution))),
      );
      expect(g.fields(A)).toMatchObject({ depends_on: [B], blocked_by_open: [], blocked: false });
      expect(g.fields(B)).toMatchObject({ blocks: [A], ready: false });
    });
  }

  it("a target closed as a duplicate blocks while its canonical issue is open", async () => {
    const log = await logOf(
      source(B, "depends-on"),
      subject(B, opened(B), closed(B, "duplicate", C)),
      subject(C, opened(C)),
    );
    const g = issueGraph(log);
    expect(g.fields(A)).toMatchObject({ depends_on: [B], blocked_by_open: [C], blocked: true });
    expect(g.fields(B)).toMatchObject({ blocks: [A], canonical: C });
    expect(g.fields(C)).toMatchObject({ blocks: [], duplicates: [B], canonical: C });
    const closedC = issueGraph(
      await logOf(
        source(B, "depends-on"),
        subject(B, opened(B), closed(B, "duplicate", C)),
        subject(C, opened(C), closed(C, "done")),
      ),
    );
    expect(closedC.fields(A)).toMatchObject({ blocked_by_open: [], blocked: false });
  });

  it("a missing or unfolded target is listed and never blocks", async () => {
    for (const s of [
      [source(Z, "depends-on")],
      [source(B, "depends-on"), { id: B, events: [issueEvent(B, "started")], body: "# B\n" }],
    ]) {
      const g = issueGraph(await logOf(...s));
      const to = s.length === 1 ? Z : B;
      expect(g.fields(A)).toMatchObject({ depends_on: [to], blocked_by_open: [], blocked: false });
      expect(g.fields(to)).toBeNull();
    }
  });

  it("a qualified target is listed and never blocks or has children", async () => {
    const g = issueGraph(
      await logOf(
        subject(
          A,
          opened(A),
          linked(A, `platform:${B}`, "depends-on"),
          linked(A, `platform:${C}`, "part-of"),
          linked(A, "adr:k3f9q8a1", "implements"),
          linked(A, `platform:${D}`, "relates-to"),
        ),
      ),
    );
    expect(g.fields(A)).toMatchObject({
      depends_on: [`platform:${B}`],
      blocked_by_open: [],
      blocked: false,
      parent: `platform:${C}`,
      implements: ["adr:k3f9q8a1"],
      relates_to: [`platform:${D}`],
      ready: true,
    });
  });

  it("a closed source is never blocked, but shows in its targets' blocks and children", async () => {
    const g = issueGraph(
      await logOf(
        subject(
          A,
          opened(A),
          linked(A, B, "depends-on"),
          linked(A, C, "part-of"),
          closed(A, "done"),
        ),
        subject(B, opened(B)),
        subject(C, opened(C)),
      ),
    );
    expect(g.fields(A)).toMatchObject({ blocked_by_open: [B], blocked: false, ready: false });
    expect(g.fields(B)?.blocks).toEqual([A]);
    expect(g.fields(C)).toMatchObject({ children: [A], ready: true });
  });

  it("assigned or in-progress issues aren't ready", async () => {
    const g = issueGraph(
      await logOf(
        subject(A, opened(A), issueEvent(A, "assigned", { data: { set: ["a@example.com"] } })),
        subject(B, opened(B), issueEvent(B, "started")),
      ),
    );
    expect(g.fields(A)?.ready).toBe(false);
    expect(g.fields(B)?.ready).toBe(false);
  });
});

describe("canonical issues", () => {
  it("follows a chain to the last folded issue", async () => {
    const g = issueGraph(
      await logOf(
        subject(A, opened(A), closed(A, "duplicate", B)),
        subject(B, opened(B), closed(B, "duplicate", C)),
        subject(C, opened(C)),
      ),
    );
    expect([g.canonicalOf(A), g.canonicalOf(B), g.canonicalOf(C)]).toEqual([C, C, C]);
  });

  it("stops at the duplicate when its of is missing or unfolded", async () => {
    const g = issueGraph(
      await logOf(
        subject(A, opened(A), closed(A, "duplicate", Z)),
        subject(B, opened(B), closed(B, "duplicate", C)),
        { id: C, events: [issueEvent(C, "started")], body: "# C\n" },
      ),
    );
    expect(g.canonicalOf(A)).toBe(A);
    expect(g.canonicalOf(B)).toBe(B);
  });

  it("is null on a duplicate cycle", async () => {
    const g = issueGraph(
      await logOf(
        subject(A, opened(A), closed(A, "duplicate", B)),
        subject(B, opened(B), closed(B, "duplicate", A)),
      ),
    );
    expect(g.canonicalOf(A)).toBeNull();
    expect(g.fields(B)?.canonical).toBeNull();
  });

  it("follows reopen: a reopened duplicate is its own canonical issue", async () => {
    const g = issueGraph(
      await logOf(
        subject(
          A,
          opened(A),
          closed(A, "duplicate", B),
          issueEvent(A, "reopened", { reason: "no" }),
        ),
        subject(B, opened(B)),
      ),
    );
    expect(g.fields(A)).toMatchObject({ canonical: A, duplicates: [] });
    expect(g.fields(B)?.duplicates).toEqual([]);
  });
});

describe("blocked_by_open", () => {
  it("never lists the issue itself (the effective self-loop)", async () => {
    const g = issueGraph(
      await logOf(
        subject(A, opened(A), linked(A, B, "depends-on")),
        subject(B, opened(B), closed(B, "duplicate", A)),
      ),
    );
    expect(g.fields(A)).toMatchObject({ blocked_by_open: [], blocked: false });
  });

  it("deduplicates canonical issues and sorts them", async () => {
    const g = issueGraph(
      await logOf(
        subject(
          A,
          opened(A),
          linked(A, D, "depends-on"),
          linked(A, B, "depends-on"),
          linked(A, C, "depends-on"),
        ),
        subject(B, opened(B), closed(B, "duplicate", D)),
        subject(C, opened(C)),
        subject(D, opened(D)),
      ),
    );
    expect(g.fields(A)?.blocked_by_open).toEqual([C, D]);
  });
});

it("builds the graph once per folded log", async () => {
  const log = await logOf(subject(A, opened(A)));
  expect(issueGraph(log)).toBe(issueGraph(log));
});

describe("derived relations (property)", () => {
  const arb = arbIssueHistory({ subjects: { min: 2, max: 8 }, links: true, duplicates: true });

  it("blocked, blocks, children and ready follow their definitions", async () => {
    await fc.assert(
      fc.asyncProperty(arb, async (h) => {
        const snap = await loadLog(new MemoryTree(h.files), {
          kind: COMPILED,
          layout: HISTORY_LAYOUT,
        });
        const log = foldLog(issueKind, snap);
        const views = projectLog(issueKind, log, { numbering: NO_NUMBERING }).views;
        const state = (id: string) => views.get(id)?.state;
        const canonical = (id: string) => views.get(id)?.canonical ?? id;
        for (const v of views.values()) {
          const localDeps = v.depends_on.filter((t) => views.has(t));
          const blocked =
            v.state !== "closed" &&
            localDeps.some((t) => canonical(t) !== v.id && state(canonical(t)) !== "closed");
          expect(v.blocked).toBe(blocked);
          const blocks = [...views.values()]
            .filter((o) => o.id !== v.id && o.depends_on.includes(v.id))
            .map((o) => o.id)
            .sort();
          expect(v.blocks).toEqual(blocks);
          const children = [...views.values()]
            .filter((o) => o.id !== v.id && o.parent === v.id)
            .map((o) => o.id)
            .sort();
          expect(v.children).toEqual(children);
          if (v.ready) {
            expect(v.state).toBe("open");
            expect(v.blocked).toBe(false);
            expect(v.assignees).toEqual([]);
            expect(v.children.every((c) => state(c) === "closed")).toBe(true);
          }
        }
      }),
      { numRuns: 200, endOnFailure: true },
    );
  });
});
