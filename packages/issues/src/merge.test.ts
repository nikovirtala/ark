import {
  compileKind,
  ENVELOPE_VERSION,
  type EventEnvelope,
  eventPath,
  type Finding,
  MemoryTree,
  NO_NUMBERING,
  nextEventIdentity,
  serializeEvent,
  verifyLog,
  verifySnapshots,
} from "@nikovirtala/ledger";
import { createTempRepo, forkAndMerge, TEST_HUMAN } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG } from "./config.js";
import { issueKind } from "./kind.js";
import { readIssuesFrom } from "./log.js";
import { TASK_V1 } from "./templates/builtin.js";
import { ISSUE_TEST_OPTIONS } from "./test-support/arbitraries.js";
import {
  COMPILED as EVENTS_COMPILED,
  foldFiles,
  IDS,
  issueEvent,
  issueFiles,
  LAYOUT,
  opened,
  type SubjectSpec,
} from "./test-support/events.js";
import {
  arbIssueBranch,
  arbIssueBranches,
  arbIssueHistory,
  HISTORY_LAYOUT,
  type IssueBranch,
  type IssueHistory,
  issueChecks,
  TEMPLATE_PATH,
  takenOf,
  taskBody,
} from "./test-support/history.js";
import { referenceLines } from "./test-support/oracle.js";

const COMPILED = compileKind(issueKind);

// ---------------------------------------------------------------------------------------------

const lines = (fs: readonly Finding[]) =>
  fs
    .filter((f) => f.severity === "error")
    .map((f) => `${f.rule} ${f.subject ?? ""}`)
    .sort();

const merges = () =>
  fc
    .oneof(
      arbIssueHistory({ maxSteps: 12 }),
      arbIssueHistory({
        maxSteps: 12,
        subjects: { min: 2, max: 5 },
        links: true,
        duplicates: true,
      }),
    )
    .chain((h) => arbIssueBranches(h).map(([left, right]) => [h, left, right] as const));
const expectedOf = (h: IssueHistory, left: IssueBranch, right: IssueBranch) =>
  referenceLines([...h.steps, ...left.steps, ...right.steps]);
const checks = issueChecks(ISSUE_TEST_OPTIONS);

async function verifyMerged(
  h: IssueHistory,
  merged: Readonly<Record<string, string>>,
): Promise<string[][]> {
  const out: string[][] = [];
  for (const [base, scope] of [
    [null, "all"],
    [new MemoryTree(h.files), "all"],
    [new MemoryTree(h.files), "changed"],
  ] as const) {
    out.push(
      lines(
        await verifySnapshots({
          kind: COMPILED,
          layout: HISTORY_LAYOUT,
          base,
          head: new MemoryTree(merged),
          scope,
          checks,
        }),
      ),
    );
  }
  return out;
}

describe("merge safety", () => {
  it("each side alone verifies clean, and only adds files", async () => {
    await fc.assert(
      fc.asyncProperty(merges(), async ([h, left, right]) => {
        for (const side of [left, right]) {
          for (const path of Object.keys(side.files))
            expect(Object.hasOwn(h.files, path)).toBe(false);
          const [all] = await verifyMerged(h, { ...h.files, ...side.files });
          expect(all).toEqual([]);
          expect(side.steps.length).toBeLessThanOrEqual(6);
          expect(side.steps.filter((s) => s.event.type === "opened").length).toBeLessThanOrEqual(2);
        }
        const leftIds = new Set(left.steps.map((s) => s.event.id));
        expect(right.steps.some((s) => leftIds.has(s.event.id))).toBe(false);
        expect(Object.keys(right.files).some((p) => Object.hasOwn(left.files, p))).toBe(false);
      }),
      { numRuns: 200, endOnFailure: true },
    );
  });

  it("reports exactly the errors the reference model finds in the merged history", async () => {
    await fc.assert(
      fc.asyncProperty(merges(), async ([h, left, right]) => {
        const want = expectedOf(h, left, right);
        for (const got of await verifyMerged(h, { ...h.files, ...left.files, ...right.files })) {
          expect(got).toEqual(want);
        }
      }),
      { numRuns: 300, endOnFailure: true },
    );
  });

  it("sees clean merges and every kind of conflict", () => {
    // The property above must see each outcome, or it would pass vacuously.
    const samples = fc.sample(merges(), { numRuns: 300, seed: 11 });
    const all = samples.flatMap(([h, l, r]) => expectedOf(h, l, r));
    expect(samples.some(([h, l, r]) => expectedOf(h, l, r).length === 0)).toBe(true);
    for (const rule of [
      "transition/illegal",
      "issue/cycle",
      "issue/multiple-parents",
      "issue/duplicate-of-duplicate",
    ]) {
      expect(
        all.some((x) => x.startsWith(`${rule} `)),
        rule,
      ).toBe(true);
    }
  });

  it("holds for real merges and rebases with forkAndMerge", async () => {
    await fc.assert(
      fc.asyncProperty(
        merges(),
        fc.constantFrom("merge" as const, "rebase" as const),
        async ([h, left, right], strategy) => {
          await using r = await createTempRepo({ files: { "README.md": "x\n", ...h.files } });
          const res = await forkAndMerge(r, {
            left: (t) => t.writeFiles(left.files),
            right: (t) => t.writeFiles(right.files),
            strategy,
          });
          const found = await verifyLog({
            git: r.git,
            kind: issueKind,
            layout: HISTORY_LAYOUT,
            mode: { type: "range", base: res.base, head: "HEAD" },
            checks,
          });
          expect(lines(found)).toEqual(expectedOf(h, left, right));
        },
      ),
      { numRuns: 25, endOnFailure: true },
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// Scripted regressions: a `GeneratorValue` replaying known choices drives `arbIssueBranch`.

const ANY = Symbol("any arbitrary");

function scripted(script: readonly (readonly [unknown, unknown])[]) {
  let i = 0;
  const g = (arb: unknown) => {
    const step = script[i++];
    if (step === undefined || (step[0] !== ANY && step[0] !== arb)) {
      throw new Error(`arbIssueBranch call ${i} does not match the script`);
    }
    return step[1] instanceof Uint8Array ? step[1].slice() : step[1];
  };
  return { g: g as unknown as fc.GeneratorValue, done: () => i === script.length };
}

const T0 = Date.parse("2026-10-20T09:00:00Z");
const T1 = T0 + 60_000;
const fill = (bytes: Uint8Array) => (buf: Uint8Array) => buf.set(bytes);
const Q_BYTES = Uint8Array.of(4, 126, 255, 4, 1, 6, 144, 5, 31, 255);

/** A base of three open issues: p at T0, q and r at T1, q's id from `Q_BYTES`. */
function scriptBase(): IssueHistory {
  const opened = (subject: string, now: number, bytes: Uint8Array): EventEnvelope => {
    const { at, id } = nextEventIdentity([], { now: () => now, random: fill(bytes) });
    return {
      envelope: ENVELOPE_VERSION,
      kind: issueKind.name,
      schema: issueKind.schema,
      id,
      subject,
      type: "opened",
      at,
      actor: TEST_HUMAN,
      data: { title: `Issue ${subject}`, template: "task", template_version: 1 },
    };
  };
  const events = [
    opened("pppppppp", T0, Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1, 1, 1)),
    opened("qqqqqqqq", T1, Q_BYTES),
    opened("rrrrrrrr", T1, Uint8Array.of(2, 2, 2, 2, 2, 2, 2, 2, 2, 2)),
  ];
  const steps = events.map((event) => ({
    subject: event.subject,
    path: eventPath(HISTORY_LAYOUT, event),
    event,
  }));
  return {
    kind: issueKind,
    layout: HISTORY_LAYOUT,
    files: {
      [TEMPLATE_PATH]: TASK_V1,
      ...issueFiles(
        events.map((e) => ({
          id: e.subject,
          events: [e],
          body: taskBody(String(e.data.title), { goal: "a goal", done: "done" }),
        })),
      ),
    },
    subjects: steps.map(({ subject, path, event }) => ({
      id: subject,
      bodyPath: `docs/issues/items/${subject}.md`,
      frozen: false,
      events: [{ path, event }],
    })),
    steps,
  };
}

const idsOf = (h: IssueHistory, ...b: IssueBranch[]) =>
  [...h.steps, ...b.flatMap((x) => x.steps)].map((s) => s.event.id);
const newIssue = (title: string) => ({ title, template: "task", template_version: 1 });

describe("merge safety, scripted regressions", () => {
  it("never reuses a base event id on a branch", () => {
    // The side comments on p in the base's last second with q's random bytes, which gives q's id.
    const h = scriptBase();
    const { g, done } = scripted([
      [fc.integer, 1], // events
      [fc.integer, 0], // clock step
      [fc.integer, 1], // an existing issue
      [fc.constantFrom, "pppppppp"],
      [fc.boolean, false],
      [fc.constantFrom, "commented"],
      [ANY, { text: "same second" }],
      [fc.uint8Array, Q_BYTES],
    ]);
    const right = arbIssueBranch(g, h, 1, takenOf(h));
    expect(done()).toBe(true);
    const ids = idsOf(h, right);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never reuses an event id within a branch", () => {
    // Two new issues in the same second from all-zero bytes would get the same id.
    const h = scriptBase();
    const zeros = new Uint8Array(10);
    const { g, done } = scripted([
      [fc.integer, 2],
      [fc.integer, 0],
      [fc.integer, 0], // a new issue
      [fc.uint8Array, Uint8Array.of(0, 0, 0, 0, 0)],
      [ANY, newIssue("one")],
      [fc.uint8Array, zeros],
      [fc.integer, 0],
      [fc.integer, 0],
      [fc.uint8Array, Uint8Array.of(0, 0, 0, 0, 2)],
      [ANY, newIssue("two")],
      [fc.uint8Array, zeros],
    ]);
    const left = arbIssueBranch(g, h, 0, takenOf(h));
    expect(done()).toBe(true);
    const ids = idsOf(h, left);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never creates the same new subject id on both sides", () => {
    const h = scriptBase();
    const script = () =>
      scripted([
        [fc.integer, 1],
        [fc.integer, 0],
        [fc.integer, 0],
        [fc.uint8Array, Uint8Array.of(1, 2, 3, 4, 4)],
        [ANY, newIssue("same bytes")],
        [fc.uint8Array, Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9, 9, 9)],
      ]);
    const taken = takenOf(h);
    const left = arbIssueBranch(script().g, h, 0, taken);
    const right = arbIssueBranch(script().g, h, 1, taken);
    const [l] = left.steps;
    const [r] = right.steps;
    expect(l?.event.type).toBe("opened");
    expect(r?.event.type).toBe("opened");
    expect(l?.subject).not.toBe(r?.subject);
    const ids = idsOf(h, left, right);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("merging a dependency with its duplicate close gives one effective self-loop", async () => {
    const h = scriptBase();
    const X = "pppppppp";
    const S = "qqqqqqqq";
    const event = (
      subject: string,
      type: string,
      data: Record<string, unknown>,
      reason?: string,
    ) => {
      const previous = h.steps.filter((s) => s.subject === subject).map((s) => s.event);
      const { at, id } = nextEventIdentity(previous, {
        now: () => T1 + 120_000 + (subject === X ? 0 : 1000),
      });
      const e: EventEnvelope = {
        envelope: ENVELOPE_VERSION,
        kind: issueKind.name,
        schema: issueKind.schema,
        id,
        subject,
        type,
        at,
        actor: TEST_HUMAN,
        ...(reason === undefined ? {} : { reason }),
        data,
      };
      const path = eventPath(HISTORY_LAYOUT, e);
      return { files: { [path]: serializeEvent(e) }, steps: [{ subject, path, event: e }] };
    };
    const left = event(X, "linked", { to: S, rel: "depends-on" });
    const right = event(S, "closed", { resolution: "duplicate", of: X }, "same work");
    for (const side of [left, right]) {
      const [all] = await verifyMerged(h, { ...h.files, ...side.files });
      expect(all).toEqual([]);
    }
    const merged = { ...h.files, ...left.files, ...right.files };
    expect(expectedOf(h, left, right)).toEqual([`issue/cycle ${X}`]);
    for (const got of await verifyMerged(h, merged)) expect(got).toEqual([`issue/cycle ${X}`]);
    const read = await readIssuesFrom(new MemoryTree(merged), {
      layout: HISTORY_LAYOUT,
      issues: DEFAULT_ISSUES_CONFIG,
      numbering: NO_NUMBERING,
      sources: null,
    });
    const cycle = read.findings.find((f) => f.rule === "issue/cycle");
    expect(cycle?.message).toBe(`depends-on cycle: ${X} → ${X} (via duplicate ${S})`);
    expect(read.projection.views.get(X)?.blocked_by_open).toEqual([]);
  });
});

describe('merge safety, a change only to the duplicates behind a finding (scope "changed")', () => {
  // verify --staged checks the changed subjects; a relate finding on an unchanged issue is kept
  // when its `related` names a changed one, so `related` must name every subject that causes it.
  const { A, B, C, D, E, F: P } = IDS;
  const closed = (id: string, resolution: string, of?: string) =>
    issueEvent(id, "closed", {
      data: { resolution, ...(of === undefined ? {} : { of }) },
      ...(resolution === "done" ? {} : { reason: "same" }),
    });
  const linked = (id: string, to: string, rel: string) =>
    issueEvent(id, "linked", { data: { to, rel } });
  const reopened = (id: string) => issueEvent(id, "reopened", { reason: "again" });

  /**
   * `rule`'s findings as `[rule, subject, related]`: the subject from verify of `head` against
   * `base` in scope "changed" (ledger's findings carry no `related`), `related` from the kind's
   * `relate` on `head`.
   */
  async function changed(
    base: readonly SubjectSpec[],
    head: readonly SubjectSpec[],
    rule: string,
  ): Promise<[string, string | null, readonly string[]][]> {
    const related = new Map(
      (issueKind.def.relate?.(await foldFiles(issueFiles(head)), ISSUE_TEST_OPTIONS) ?? [])
        .filter((f) => f.rule === rule)
        .map((f) => [f.subject, f.related ?? []]),
    );
    const fs = await verifySnapshots({
      kind: EVENTS_COMPILED,
      layout: LAYOUT,
      base: new MemoryTree(issueFiles(base)),
      head: new MemoryTree(issueFiles(head)),
      scope: "changed",
      checks,
    });
    return fs
      .filter((f) => f.rule === rule)
      .map((f) => [f.rule, f.subject, related.get(f.subject ?? "") ?? []]);
  }

  const e = opened(E);
  const eDependsOnD = linked(E, D, "depends-on");
  const [d, p] = [opened(D), opened(P)];
  const dDupP = closed(D, "duplicate", P);
  const pDupE = closed(P, "duplicate", E);

  it("reports the effective self-loop on E when only both duplicates changed", async () => {
    // E depends on D; D becomes a duplicate of P and P one of E: E → E via D and P.
    const base = [
      { id: E, events: [e, eDependsOnD] },
      { id: D, events: [d] },
      { id: P, events: [p] },
    ];
    const head = [
      { id: E, events: [e, eDependsOnD] },
      { id: D, events: [d, dDupP] },
      { id: P, events: [p, pDupE] },
    ];
    expect(await changed(base, head, "issue/cycle")).toEqual([["issue/cycle", E, [D, P]]]);
  });

  it("reports it when only the first duplicate changed", async () => {
    const base = [
      { id: E, events: [e, eDependsOnD] },
      { id: D, events: [d] },
      { id: P, events: [p, pDupE] },
    ];
    const head = [
      { id: E, events: [e, eDependsOnD] },
      { id: D, events: [d, dDupP] },
      { id: P, events: [p, pDupE] },
    ];
    expect(await changed(base, head, "issue/cycle")).toEqual([["issue/cycle", E, [D, P]]]);
  });

  it("reports it when only the last duplicate changed", async () => {
    const base = [
      { id: E, events: [e, eDependsOnD] },
      { id: D, events: [d, dDupP] },
      { id: P, events: [p] },
    ];
    const head = [
      { id: E, events: [e, eDependsOnD] },
      { id: D, events: [d, dDupP] },
      { id: P, events: [p, pDupE] },
    ];
    expect(await changed(base, head, "issue/cycle")).toEqual([["issue/cycle", E, [D, P]]]);
  });

  it("reports closed-with-open-dependencies when only a duplicate behind the blocker changed", async () => {
    // A is closed as done and depends on B, B is a duplicate of D. D was closed as done, then
    // becomes a duplicate of the open C, so C blocks A.
    const [a, aOnB, aDone] = [opened(A), linked(A, B, "depends-on"), closed(A, "done")];
    const [b, bDupD, c, dd] = [opened(B), closed(B, "duplicate", D), opened(C), opened(D)];
    const dDone = closed(D, "done");
    const common = [
      { id: A, events: [a, aOnB, aDone] },
      { id: B, events: [b, bDupD] },
      { id: C, events: [c] },
    ];
    const base = [...common, { id: D, events: [dd, dDone] }];
    const head = [
      ...common,
      { id: D, events: [dd, dDone, reopened(D), closed(D, "duplicate", C)] },
    ];
    expect(await changed(base, head, "issue/closed-with-open-dependencies")).toEqual([
      ["issue/closed-with-open-dependencies", A, [B, C, D]],
    ]);
  });
});
