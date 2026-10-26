import {
  compileKind,
  extractSections,
  lintDocument,
  MemoryTree,
  parseEventYaml,
  verifySnapshots,
} from "@nikovirtala/ledger";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { issueKind, labelPrefix } from "../kind.js";
import { TASK_V1 } from "../templates/builtin.js";
import { arbTitle, ISSUE_TEST_OPTIONS } from "./arbitraries.js";
import {
  arbIssueHistory,
  arbIssueMutation,
  dependsOnEdges,
  finalGraphs,
  HISTORY_LAYOUT,
  type IssueHistory,
  issueChecks,
  MUTATION_TYPES,
  partOfEdges,
  reaches,
  TASK_TEMPLATE,
  TEMPLATE_PATH,
} from "./history.js";

const COMPILED = compileKind(issueKind);
const RUNS = { numRuns: 300, seed: 20261026, endOnFailure: true } as const;

/** Every guarantee of `arbIssueHistory` that doesn't need a fold. */
async function checkGuarantees(h: IssueHistory): Promise<void> {
  const ids = h.subjects.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  const eventIds = h.steps.map((s) => s.event.id);
  expect(new Set(eventIds).size).toBe(eventIds.length);
  expect(h.files[TEMPLATE_PATH]).toBe(TASK_V1);

  for (const step of h.steps) {
    const parsed = parseEventYaml(h.files[step.path] ?? "", { file: step.path });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) continue;
    expect(parsed.doc).toEqual(step.event);
    const held = h.subjects
      .find((s) => s.id === step.subject)
      ?.events.find((e) => e.path === step.path)?.event;
    expect(held).toEqual(step.event);
    if (step.event.type === "closed") expect(String(step.event.reason ?? "").trim()).not.toBe("");
    if (step.event.type === "opened") expect(step.event.data.parent).not.toBe(step.subject);
  }

  for (const s of h.subjects) {
    const title = s.events.find((e) => e.event.type === "opened")?.event.data.title;
    const body = s.bodyPath === null ? undefined : h.files[s.bodyPath];
    expect(body).toBeDefined();
    expect(extractSections(TASK_TEMPLATE, body ?? "").title).toBe(title);
    expect(lintDocument(TASK_TEMPLATE, body ?? "")).toEqual([]);
  }

  const g = finalGraphs(h);
  const exclusive = new Set(ISSUE_TEST_OPTIONS.exclusive);
  for (const id of g.subjects) {
    const st = g.state(id);
    const prefixes = (st?.labels ?? [])
      .map(labelPrefix)
      .filter((p) => p !== null && exclusive.has(p));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(reaches((x) => dependsOnEdges(g, x), id, id)).toBe(false);
    expect(reaches((x) => partOfEdges(g, x), id, id)).toBe(false);
    expect((st?.links ?? []).filter((l) => l.rel === "part-of").length).toBeLessThanOrEqual(1);
    if (st?.duplicateOf !== null && st?.duplicateOf !== undefined && g.status(id) === "closed") {
      const of = g.state(st.duplicateOf);
      expect(g.status(st.duplicateOf) === "closed" && of?.resolution === "duplicate").toBe(false);
    }
  }
}

/** Errors `verify` reports for `h` on a MemoryTree, in scope `all`. */
async function errorsOf(h: IssueHistory): Promise<string[]> {
  const findings = await verifySnapshots({
    kind: COMPILED,
    layout: HISTORY_LAYOUT,
    base: null,
    head: new MemoryTree(h.files),
    scope: "all",
    checks: issueChecks(),
  });
  return findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.message}`);
}

describe("arbIssueHistory", () => {
  const variants = {
    plain: arbIssueHistory(),
    "subjects 2..8, link- and duplicate-weighted": arbIssueHistory({
      subjects: { min: 2, max: 8 },
      links: true,
      duplicates: true,
    }),
    "maxSteps 12, link- and duplicate-weighted": arbIssueHistory({
      maxSteps: 12,
      links: true,
      duplicates: true,
    }),
  };
  for (const [name, arb] of Object.entries(variants)) {
    it(`${name}: holds every stated guarantee and verifies with no error`, async () => {
      await fc.assert(
        fc.asyncProperty(arb, async (h) => {
          await checkGuarantees(h);
          expect(await errorsOf(h)).toEqual([]);
        }),
        RUNS,
      );
    });
  }

  it("the weighted variant produces duplicates, dependencies and parents", () => {
    const seen = { duplicate: 0, dependsOn: 0, partOf: 0 };
    fc.assert(
      fc.property(variants["subjects 2..8, link- and duplicate-weighted"], (h) => {
        const types = h.steps.map((s) => s.event);
        if (types.some((e) => e.type === "closed" && e.data.resolution === "duplicate"))
          seen.duplicate++;
        if (types.some((e) => e.type === "linked" && e.data.rel === "depends-on")) seen.dependsOn++;
        if (types.some((e) => e.type === "linked" && e.data.rel === "part-of")) seen.partOf++;
      }),
      RUNS,
    );
    expect(seen.duplicate).toBeGreaterThan(30);
    expect(seen.dependsOn).toBeGreaterThan(60);
    expect(seen.partOf).toBeGreaterThan(60);
  });
});

describe("arbTitle", () => {
  it("is 1 to 80 characters on one line, trimmed, not starting with #", () => {
    fc.assert(
      fc.property(arbTitle, (t) => {
        expect(t.length).toBeGreaterThanOrEqual(1);
        expect(t.length).toBeLessThanOrEqual(80);
        expect(t).toBe(t.trim());
        expect(t).not.toMatch(/[\r\n]/);
        expect(t.startsWith("#")).toBe(false);
      }),
      RUNS,
    );
  });
});

describe("arbIssueMutation", () => {
  const weighted = arbIssueHistory({ subjects: { min: 2, max: 8 }, links: true, duplicates: true });
  for (const type of MUTATION_TYPES) {
    it(`${type}: has a candidate in at least 20% of histories, and appends fresh events`, () => {
      let found = 0;
      const base = ["cycle-edge", "of-at-duplicate", "second-parent"].includes(type)
        ? weighted
        : arbIssueHistory();
      fc.assert(
        fc.property(base, fc.gen(), (h, g) => {
          const arb = arbIssueMutation(h, { only: [type] });
          if (arb === null) return;
          found++;
          const m = g(() => arb);
          expect(m.type).toBe(type);
          if (Object.hasOwn(h.files, m.path)) return;
          const parsed = parseEventYaml(m.content, { file: m.path });
          if (!parsed.ok) throw new Error(m.content);
          const e = parsed.doc as { id: string; at: string };
          expect(h.steps.some((s) => s.event.id === e.id)).toBe(false);
          for (const s of h.steps) expect(Date.parse(e.at)).toBeGreaterThan(Date.parse(s.event.at));
        }),
        RUNS,
      );
      expect(found).toBeGreaterThanOrEqual(60);
    });
  }

  it("is null exactly when no type has a candidate", () => {
    fc.assert(
      fc.property(arbIssueHistory({ subjects: { min: 1, max: 1 }, maxSteps: 1 }), (h) => {
        expect(
          arbIssueMutation(h, { only: ["cycle-edge", "second-parent", "agent-close"] }),
        ).toBeNull();
        expect(arbIssueMutation(h)).not.toBeNull();
      }),
      RUNS,
    );
  });
});
