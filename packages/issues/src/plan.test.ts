import { type EventEnvelope, UsageError } from "@nikovirtala/ledger";
import { TEST_HUMAN } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { issueKind, type SourceLog } from "./kind.js";
import {
  type PlanResult,
  planClose,
  planComment,
  planEdit,
  planLink,
  planOpen,
  planReopen,
  planSet,
  planStart,
  planStop,
  planUnlink,
  type WritePlan,
} from "./plan.js";
import { TEST_AGENT } from "./test-support/arbitraries.js";
import {
  IDS,
  issueEvent,
  issueFiles,
  numberingOf,
  opened,
  type SubjectSpec,
} from "./test-support/events.js";
import { MemoryLog } from "./test-support/plans.js";

const { A, B, C, D, E, X, Z } = IDS;
const ME = TEST_HUMAN;
const closed = (id: string, resolution: string, of?: string) =>
  issueEvent(id, "closed", {
    data: { resolution, ...(of === undefined ? {} : { of }) },
    reason: "because",
  });
const linked = (id: string, to: string, rel: string) =>
  issueEvent(id, "linked", { data: { to, rel } });
const subject = (id: string, ...events: EventEnvelope[]): SubjectSpec => ({ id, events });

function memory(subjects: SubjectSpec[], o: ConstructorParameters<typeof MemoryLog>[1] = {}) {
  return new MemoryLog(issueFiles(subjects), {
    numbering: numberingOf({ [A]: 1, [B]: 2, [C]: 3, [D]: 4, [X]: 5 }),
    issues: { exclusive: ["priority", "type"] },
    ...o,
  });
}

/** Plans with `f` on the log's current read, applying the plan when it is ok. */
async function run(
  log: MemoryLog,
  f: (
    read: Awaited<ReturnType<MemoryLog["read"]>>,
    c: ReturnType<MemoryLog["context"]>,
  ) => Promise<PlanResult>,
): Promise<PlanResult> {
  const read = await log.read();
  const r = await f(read, log.context(read));
  if (r.ok) log.apply(r.plan);
  return r;
}

const plan = (r: PlanResult): WritePlan => {
  if (!r.ok)
    throw new Error(`refused: ${r.findings.map((f) => `${f.rule} ${f.message}`).join("; ")}`);
  return r.plan;
};
const refusedRules = (r: PlanResult) => (r.ok ? [] : r.findings.map((f) => f.rule));
async function usage(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  return (err as Error).message;
}

const link = (log: MemoryLog, id: string, to: string, rel?: string) =>
  run(log, (read, c) => planLink(read, { id, to, rel: rel ?? null, actor: ME }, c));
const close = (
  log: MemoryLog,
  id: string,
  o: { resolution?: string; of?: string; reason?: string; actor?: typeof ME } = {},
) => run(log, (read, c) => planClose(read, { id, actor: o.actor ?? ME, ...o }, c));

describe("relations through link", () => {
  const three = () => memory([subject(A, opened(A)), subject(B, opened(B)), subject(C, opened(C))]);

  for (const rel of ["depends-on", "part-of", "relates-to"]) {
    it(`${rel}: a self-link, an unknown or unfolded target and a decision are usage errors`, async () => {
      const log = memory([
        subject(A, opened(A)),
        { id: B, events: [issueEvent(B, "started")], body: "# B\n" },
      ]);
      expect(await usage(link(log, A, "1", rel))).toBe("an issue can't link to itself");
      expect(await usage(link(log, A, Z, rel))).toBe(`unknown issue ${Z}`);
      expect(await usage(link(log, A, B, rel))).toContain("has no valid opened event");
      expect(await usage(link(log, A, "ADR-0001", rel))).toContain(`${rel} needs an issue`);
      expect(await usage(link(log, A, `issues:${B}`, rel))).toContain("unknown source issues");
    });

    it(`${rel}: writes linked once, then says already linked`, async () => {
      const log = three();
      const first = plan(await link(log, A, "?2", rel));
      expect(first.events.map((e) => [e.type, e.data])).toEqual([["linked", { to: B, rel }]]);
      expect(first.commit).toMatchObject({
        action: "link",
        before: "?1",
        after: "to ?2",
        quote: true,
        body: [`${rel} ?2: Issue ${B}.`],
      });
      expect(first.affected.map((v) => v.id)).toEqual([B]);
      const again = plan(await link(log, A, B, rel));
      expect(again.events).toEqual([]);
      expect(again.notes).toEqual([`already linked: ?1 ${rel} ?2; nothing written`]);
    });

    it(`${rel}: a closed or in-progress source and a closed target are allowed`, async () => {
      const log = memory([
        subject(A, opened(A), issueEvent(A, "started")),
        subject(B, opened(B), closed(B, "wontfix")),
        subject(C, opened(C), closed(C, "done")),
      ]);
      expect((await link(log, A, B, rel)).ok).toBe(true);
      expect((await link(log, C, B, rel === "part-of" ? "relates-to" : rel)).ok).toBe(true);
    });
  }

  it("depends-on and part-of refuse raw cycles; relates-to allows them", async () => {
    for (const rel of ["depends-on", "part-of"]) {
      const log = three();
      plan(await link(log, A, B, rel));
      expect(refusedRules(await link(log, B, A, rel))).toEqual(["issue/cycle"]);
    }
    const log = three();
    plan(await link(log, A, B));
    expect((await link(log, B, A)).ok).toBe(true);
  });

  it("refuses a cycle through a duplicate's canonical issue, whichever write closes it", async () => {
    // A → B, B duplicate of C, C → A.
    const viaLink = three();
    plan(await link(viaLink, A, B, "depends-on"));
    plan(await close(viaLink, B, { of: C, reason: "same" }));
    expect(refusedRules(await link(viaLink, C, A, "depends-on"))).toEqual(["issue/cycle"]);
    const viaClose = three();
    plan(await link(viaClose, A, B, "depends-on"));
    plan(await link(viaClose, C, A, "depends-on"));
    expect(refusedRules(await close(viaClose, B, { of: C, reason: "same" }))).toEqual([
      "issue/cycle",
    ]);
  });

  it("refuses the effective self-loop both ways", async () => {
    const byClose = three();
    plan(await link(byClose, C, B, "depends-on"));
    const r = await close(byClose, B, { of: C, reason: "same" });
    expect(r.ok ? [] : r.findings.map((f) => [f.rule, f.message])).toEqual([
      ["issue/cycle", `depends-on cycle: ${C} → ${C} (via duplicate ${B})`],
    ]);
    const byLink = three();
    plan(await close(byLink, B, { of: C, reason: "same" }));
    expect(refusedRules(await link(byLink, C, B, "depends-on"))).toEqual(["issue/cycle"]);
  });

  it("refuses a second parent with a hint to unlink the first", async () => {
    const log = three();
    plan(await link(log, A, B, "part-of"));
    const r = await link(log, A, C, "part-of");
    expect(refusedRules(r)).toEqual(["issue/multiple-parents"]);
    expect(r.ok ? [] : r.notes).toEqual([
      "?1 already has a parent; unlink it first: issues unlink ?1 ?2 --rel part-of",
    ]);
  });

  it("implements needs a decision of the local log, stored as adr:<id>", async () => {
    const decisions = {
      root: "docs/adr",
      configPath: null,
      numbering: numberingOf({ k3f9q8a1: 7 }),
      ids: new Set(["k3f9q8a1"]),
      views: new Map([
        [
          "k3f9q8a1",
          {
            display: "ADR-0007",
            title: "Use queues.",
            status: "accepted",
            effective: "k3f9q8a1",
          } as never,
        ],
      ]),
    };
    const sources: ReadonlyMap<string, SourceLog> = new Map([
      [
        "adr",
        {
          kind: "adr",
          local: true,
          subjects: new Map([
            ["k3f9q8a1", { status: "accepted", display: "ADR-0007", title: "x", effective: null }],
          ]),
        },
      ],
      ["platform", { kind: "issues", local: false, subjects: null }],
    ]);
    const log = memory([subject(A, opened(A)), subject(B, opened(B))], { decisions, sources });
    const r = plan(await link(log, A, "ADR-0007", "implements"));
    expect(r.events[0]?.data).toEqual({ to: "adr:k3f9q8a1", rel: "implements" });
    expect(r.commit).toMatchObject({
      after: "to ADR-0007",
      body: ["implements ADR-0007: Use queues."],
    });
    expect(await usage(link(log, A, B, "implements"))).toBe(
      `${B} is an issue; implements needs a decision`,
    );
    const cross = plan(await link(log, A, `platform:${Z}`, "depends-on"));
    expect(cross.commit).toMatchObject({
      after: "to an issue in another log",
      body: [`depends-on platform:${Z}.`],
    });
  });

  it("joins existing cycle components without refusing, in an already invalid log", async () => {
    // A ↔ B and C ↔ D are cycles, and C → A; ids sort A < B < C < D.
    const log = memory([
      subject(A, opened(A), linked(A, B, "depends-on")),
      subject(B, opened(B), linked(B, A, "depends-on")),
      subject(C, opened(C), linked(C, D, "depends-on"), linked(C, A, "depends-on")),
      subject(D, opened(D), linked(D, C, "depends-on")),
    ]);
    expect(
      (await log.read()).findings.filter((f) => f.rule === "issue/cycle").map((f) => f.subject),
    ).toEqual([A, C]);
    expect((await link(log, A, C, "depends-on")).ok).toBe(true);
    const read = await log.read();
    const after = (issueKind.def.relate?.(read.folded, read.options) ?? []).filter(
      (f) => f.rule === "issue/cycle",
    );
    expect(after.map((f) => [f.subject, f.message, f.related])).toEqual([
      [A, `depends-on cycle: ${A} → ${B} → ${A}`, [B, C, D]],
    ]);
  });
});

describe("unlink", () => {
  it("removes a dangling or unknown-source link by its stored target", async () => {
    const log = memory(
      [subject(A, opened(A), linked(A, Z, "depends-on"), linked(A, `gone:${B}`, "relates-to"))],
      {
        sources: new Map(),
      },
    );
    expect((await log.read()).findings.map((f) => f.rule).sort()).toEqual([
      "issue/reference-missing",
      "issue/unknown-source",
    ]);
    plan(await run(log, (read, c) => planUnlink(read, { id: A, to: Z, actor: ME }, c)));
    plan(await run(log, (read, c) => planUnlink(read, { id: A, to: `gone:${B}`, actor: ME }, c)));
    expect((await log.read()).findings).toEqual([]);
  });

  it("resolves numbers when nothing matches verbatim, asks for --rel, and notes absent links", async () => {
    const log = memory([
      subject(A, opened(A), linked(A, B, "depends-on"), linked(A, B, "relates-to")),
      subject(B, opened(B)),
    ]);
    const unlink = (to: string, rel?: string) =>
      run(log, (read, c) => planUnlink(read, { id: A, to, rel: rel ?? null, actor: ME }, c));
    expect(await usage(unlink("?2"))).toBe(
      "?1 has several relations to ?2 (depends-on, relates-to); give --rel",
    );
    const r = plan(await unlink("2", "depends-on"));
    expect(r.events[0]?.data).toEqual({ to: B, rel: "depends-on" });
    expect(r.commit).toMatchObject({ action: "unlink", before: "?1", after: "from ?2" });
    expect(plan(await unlink("?2", "depends-on")).notes).toEqual([
      "not linked: ?1 depends-on ?2; nothing written",
    ]);
    expect(plan(await unlink("?2")).events).toHaveLength(1);
  });

  it("repairs merged states whose findings list links: three parents, overlapping cycles", async () => {
    const parents = memory([
      subject(
        A,
        opened(A),
        linked(A, B, "part-of"),
        linked(A, C, "part-of"),
        linked(A, D, "part-of"),
      ),
      subject(B, opened(B)),
      subject(C, opened(C)),
      subject(D, opened(D)),
    ]);
    const first = plan(
      await run(parents, (read, c) => planUnlink(read, { id: A, to: B, actor: ME }, c)),
    );
    expect(first.notes).toEqual([
      `issue/multiple-parents: part of more than one issue: ${C}, ${D}`,
    ]);
    plan(await run(parents, (read, c) => planUnlink(read, { id: A, to: C, actor: ME }, c)));
    expect((await parents.read()).findings).toEqual([]);

    const cycles = memory([
      subject(A, opened(A), linked(A, B, "depends-on"), linked(A, C, "depends-on")),
      subject(B, opened(B), linked(B, A, "depends-on")),
      subject(C, opened(C), linked(C, A, "depends-on")),
    ]);
    const unlink = (id: string, to: string) =>
      run(cycles, (read, c) => planUnlink(read, { id, to, actor: ME }, c));
    expect(plan(await unlink(A, B)).notes?.every((n) => n.startsWith("issue/cycle: "))).toBe(true);
    plan(await unlink(C, A));
    expect((await cycles.read()).findings).toEqual([]);
  });

  it("clears the parent from opened.parent", async () => {
    const log = memory([{ id: A, events: [opened(A, "A", B)] }, subject(B, opened(B))]);
    plan(await run(log, (read, c) => planUnlink(read, { id: A, to: B, actor: ME }, c)));
    expect((await log.read()).projection.views.get(A)?.parent).toBeNull();
  });
});

describe("closing", () => {
  const log = () => memory([subject(A, opened(A)), subject(B, opened(B))]);

  it("needs a reason unless done; refuses an illegal transition", async () => {
    const l = log();
    expect(refusedRules(await close(l, A, { resolution: "wontfix" }))).toEqual([
      "issue/reason-required",
    ]);
    expect(plan(await close(l, A, { resolution: "wontfix", reason: "no" })).commit).toMatchObject({
      action: "close",
      before: "?1",
      after: "as won't fix",
      body: ["Reason: no"],
    });
    expect(refusedRules(await close(l, A))).toEqual(["transition/illegal"]);
    expect(plan(await close(l, B, { resolution: "obsolete", reason: "x" })).commit?.after).toBe(
      "as obsolete",
    );
  });

  it("checks the --duplicate-of and --resolution combinations", async () => {
    const l = log();
    expect(await usage(close(l, A, { of: "1" }))).toBe("an issue can't be a duplicate of itself");
    expect(await usage(close(l, A, { of: B, resolution: "wontfix" }))).toContain(
      "can't be combined",
    );
    expect(await usage(close(l, A, { resolution: "duplicate" }))).toContain("needs --duplicate-of");
    expect(await usage(close(l, A, { resolution: "nope" }))).toContain("unknown --resolution nope");
    expect(await usage(close(l, A, { of: `platform:${B}` }))).toContain("is in another log");
    const r = plan(await close(l, A, { of: "?2", reason: "same" }));
    expect(r.events[0]?.data).toEqual({ resolution: "duplicate", of: B });
    expect(r.commit?.after).toBe("as a duplicate of ?2");
    expect(r.affected.map((v) => v.id)).toEqual([B]);
  });

  it("refuses closing as a duplicate of a duplicate, and the re-pointing case", async () => {
    const l = memory([
      subject(A, opened(A)),
      subject(B, opened(B), closed(B, "duplicate", C)),
      subject(C, opened(C)),
    ]);
    expect(refusedRules(await close(l, A, { of: B, reason: "same" }))).toEqual([
      "issue/duplicate-of-duplicate",
    ]);
    const r = memory([
      subject(A, opened(A), closed(A, "duplicate", B)),
      subject(B, opened(B)),
      subject(C, opened(C)),
    ]);
    const repoint = await close(r, B, { of: C, reason: "same" });
    expect(refusedRules(repoint)).toEqual(["issue/duplicate-of-duplicate"]);
    expect(repoint.ok ? [] : repoint.notes).toEqual([
      "reopen ?1 and close it as a duplicate of ?3 first",
    ]);
  });

  it("passes with warnings for open work", async () => {
    const l = memory([
      subject(A, opened(A), linked(A, B, "depends-on")),
      subject(B, opened(B)),
      { id: C, events: [opened(C, "C", A)] },
    ]);
    const r = plan(await close(l, A));
    expect(r.findings.map((f) => [f.severity, f.rule]).sort()).toEqual([
      ["warning", "issue/closed-with-open-children"],
      ["warning", "issue/closed-with-open-dependencies"],
    ]);
  });

  it("applies the agent policy", async () => {
    const agent = TEST_AGENT;
    expect(refusedRules(await close(log(), A, { actor: agent }))).toEqual([
      "issue/agent-reason-required",
    ]);
    expect((await close(log(), A, { actor: agent, reason: "tests pass" })).ok).toBe(true);
    for (const issues of [{ closeRequiresHuman: true }, { mcpCanClose: false }]) {
      const l = memory([subject(A, opened(A))], { issues: { exclusive: [], ...issues } });
      expect(refusedRules(await close(l, A, { actor: agent, reason: "done" }))).toEqual([
        "issue/agent-closed",
      ]);
      expect((await close(l, A, { reason: "done" })).ok).toBe(true);
      expect(
        (await run(l, (read, c) => planReopen(read, { id: A, reason: "again", actor: agent }, c)))
          .ok,
      ).toBe(true);
    }
  });

  it("reopen needs a reason and a closed issue", async () => {
    const l = memory([subject(A, opened(A), closed(A, "done")), subject(B, opened(B))]);
    expect(
      refusedRules(await run(l, (read, c) => planReopen(read, { id: A, actor: ME }, c))),
    ).toEqual(["event/reason-required"]);
    expect(
      refusedRules(
        await run(l, (read, c) => planReopen(read, { id: B, reason: "x", actor: ME }, c)),
      ),
    ).toEqual(["transition/illegal"]);
    expect(
      plan(await run(l, (read, c) => planReopen(read, { id: A, reason: "back", actor: ME }, c)))
        .commit,
    ).toMatchObject({
      action: "reopen",
      before: "?1",
      body: ["Reason: back"],
    });
  });
});

describe("start and stop", () => {
  it("assigns me when unassigned, notes another assignee, and warns when blocked", async () => {
    const l = memory([
      subject(A, opened(A), linked(A, B, "depends-on")),
      subject(B, opened(B)),
      subject(C, opened(C), issueEvent(C, "assigned", { data: { set: ["bob@example.com"] } })),
    ]);
    const a = plan(await run(l, (read, c) => planStart(read, { id: A, actor: ME }, c)));
    expect(a.events.map((e) => [e.type, e.data])).toEqual([
      ["started", {}],
      ["assigned", { set: ["test@example.com"] }],
    ]);
    expect(a.trailers).toEqual([
      ["Issue", A],
      ["Issue-Event", "started"],
      ["Issue", A],
      ["Issue-Event", "assigned"],
    ]);
    expect(a.findings.map((f) => [f.severity, f.rule, f.message])).toEqual([
      ["warning", "issue/started-blocked", "?1 is blocked by ?2 (open); finish them first"],
    ]);
    const cc = plan(await run(l, (read, c) => planStart(read, { id: C, actor: ME }, c)));
    expect(cc.events.map((e) => e.type)).toEqual(["started"]);
    expect(cc.notes).toEqual(["?3 is assigned to bob@example.com"]);
    const stop = plan(
      await run(l, (read, c) => planStop(read, { id: C, reason: "later", actor: ME }, c)),
    );
    expect(stop.commit).toMatchObject({
      action: "stop work on",
      before: "?3",
      body: ["Reason: later"],
    });
    expect(
      refusedRules(await run(l, (read, c) => planStop(read, { id: C, actor: ME }, c))),
    ).toEqual(["transition/illegal"]);
  });
});

describe("sets and label exclusivity", () => {
  const label = (log: MemoryLog, op: { set?: string[]; add?: string[]; remove?: string[] }) =>
    run(log, (read, c) => planSet(read, "label", { id: A, op, actor: ME }, c));
  const withLabels = (...labels: string[]) =>
    memory([
      subject(
        A,
        opened(A),
        ...(labels.length === 0 ? [] : [issueEvent(A, "labeled", { data: { set: labels } })]),
      ),
    ]);

  it("adds, replaces an exclusive prefix, or keeps both", async () => {
    expect(plan(await label(withLabels(), { add: ["priority:high"] })).events[0]?.data).toEqual({
      set: ["priority:high"],
    });
    const replaced = plan(await label(withLabels("priority:low"), { add: ["priority:high"] }));
    expect(replaced.events[0]?.data).toEqual({ set: ["priority:high"] });
    expect(replaced.notes).toEqual(["replaced priority:low (priority is exclusive)"]);
    const both = plan(await label(withLabels("area:low"), { add: ["area:high"] }));
    expect(both.events[0]?.data).toEqual({ set: ["area:high", "area:low"] });
  });

  it("refuses two labels of one exclusive prefix", async () => {
    expect(
      refusedRules(await label(withLabels(), { add: ["priority:high", "priority:low"] })),
    ).toEqual(["issue/label-exclusive"]);
    expect(
      refusedRules(await label(withLabels(), { set: ["priority:high", "priority:low"] })),
    ).toEqual(["issue/label-exclusive"]);
    const l = memory([subject(A, opened(A))]);
    const r = await run(l, (read, c) =>
      planOpen(read, { title: "x", labels: ["type:bug", "type:feature"], actor: ME }, c),
    );
    expect(refusedRules(r)).toEqual(["issue/label-exclusive"]);
  });

  it("removes, notes absent items, clears, and writes nothing when unchanged", async () => {
    expect(
      plan(await label(withLabels("priority:low"), { remove: ["priority:low"] })).events[0]?.data,
    ).toEqual({ set: [] });
    const absent = plan(await label(withLabels(), { remove: ["x"] }));
    expect(absent.events).toEqual([]);
    expect(absent.notes).toEqual([`x is not a label of ?1 (${A})`]);
    expect(plan(await label(withLabels("a"), { add: ["a"] })).notes).toEqual([
      `a is already a label of ?1 (${A})`,
    ]);
    expect(plan(await label(withLabels("a", "b"), { set: [] })).events[0]?.data).toEqual({
      set: [],
    });
    expect(await usage(label(withLabels(), { add: ["bad label"] }))).toBe(
      'invalid label "bad label"',
    );
  });

  it("allows a write that fixes a set a newly exclusive prefix breaks, and refuses one that doesn't", async () => {
    const l = memory(
      [subject(A, opened(A), issueEvent(A, "labeled", { data: { set: ["area:a", "area:b"] } }))],
      {
        issues: { exclusive: ["area"] },
      },
    );
    expect(refusedRules(await label(l, { add: ["x"] }))).toEqual(["issue/label-exclusive"]);
    expect((await label(l, { remove: ["area:b"] })).ok).toBe(true);
  });

  it("assign takes me; scope notes unmatched globs", async () => {
    const l = memory([subject(A, opened(A))]);
    const a = plan(
      await run(l, (read, c) =>
        planSet(read, "assign", { id: A, op: { add: ["me", "dee"] }, actor: ME }, c),
      ),
    );
    expect(a.events[0]?.data).toEqual({ set: ["dee", "test@example.com"] });
    expect(a.commit).toMatchObject({ action: "set the assignees of", before: "?1", quote: true });
    expect(
      await usage(
        run(l, (read, c) =>
          planSet(read, "assign", { id: A, op: { add: ["me"] }, actor: { ...ME, email: null } }, c),
        ),
      ),
    ).toContain("me needs your email");
    const s = plan(
      await run(l, (read, c) =>
        planSet(read, "scope", { id: A, op: { set: ["src/**", "nothing/**"] }, actor: ME }, c, {
          tracked: ["src/a.ts"],
        }),
      ),
    );
    expect(s.notes).toEqual([
      `nothing/** matches no tracked file; verify reports scope/glob-unmatched once ${s.issue?.display} is started, until a file matches`,
    ]);
    expect(
      await usage(
        run(l, (read, c) => planSet(read, "scope", { id: A, op: { add: ["["] }, actor: ME }, c)),
      ),
    ).toBeTruthy();
  });
});

describe("new", () => {
  it("writes the body, the materialized template and opened, labeled and linked events", async () => {
    const l = memory([subject(A, opened(A)), subject(B, opened(B))]);
    l.files = Object.fromEntries(
      Object.entries(l.files).filter(([p]) => !p.endsWith("templates/task.md")),
    );
    const r = plan(
      await run(l, (read, c) =>
        planOpen(
          read,
          {
            title: "Split it",
            parent: "1",
            dependsOn: ["2", B],
            labels: ["type:bug"],
            sections: { goal: "g", done: "d" },
            actor: ME,
          },
          c,
        ),
      ),
    );
    const id = r.subject;
    expect(r.events.map((e) => [e.type, e.data])).toEqual([
      ["opened", { title: "Split it", template: "task", template_version: 1, parent: A }],
      ["labeled", { set: ["type:bug"] }],
      ["linked", { to: B, rel: "depends-on" }],
    ]);
    const body = `docs/issues/items/${id}-split-it.md`;
    expect(Object.keys(r.files).slice(0, 2)).toEqual([body, "docs/issues/templates/task.md"]);
    expect(r.commitScope).toEqual(
      [`docs/issues/events/${id}`, body, "docs/issues/templates/task.md"].sort(),
    );
    expect(r.commit).toMatchObject({ action: "open", title: "Split it", before: "", quote: true });
    expect(r.findings).toEqual([]);
    expect(r.issue).toMatchObject({ parent: A, depends_on: [B], blocked: true });
  });

  it("refuses an incomplete draft when asked, and checks its inputs", async () => {
    const l = memory([]);
    const r = await run(l, (read, c) =>
      planOpen(read, { title: "Draft", actor: ME }, c, { refuseIncomplete: true }),
    );
    expect(r.ok).toBe(false);
    expect(refusedRules(r)).toContain("template/guidance-left");
    expect(
      plan(await run(l, (read, c) => planOpen(read, { title: "Draft", actor: ME }, c))).findings
        .length,
    ).toBeGreaterThan(0);
    expect(
      await usage(run(l, (read, c) => planOpen(read, { title: " ", actor: ME }, c))),
    ).toContain("the title must be");
    expect(
      await usage(
        run(l, (read, c) => planOpen(read, { title: "x", template: "nope", actor: ME }, c)),
      ),
    ).toContain("unknown template nope");
    expect(
      await usage(
        run(l, (read, c) => planOpen(read, { title: "x", sections: { nope: "y" }, actor: ME }, c)),
      ),
    ).toContain("has no section nope");
    expect(
      await usage(
        run(l, (read, c) =>
          planOpen(
            read,
            { title: "x", dependsOn: Array.from({ length: 51 }, () => A), actor: ME },
            c,
          ),
        ),
      ),
    ).toBe("--depends-on can be given at most 50 times");
  });
});

describe("edit", () => {
  const body = "# Old\n\n## Goal\nold goal\n\n## Notes\n\n## Done when\nold done\n";
  const log = () => memory([{ id: A, events: [opened(A, "Old")], body }]);

  it("replaces the title and sections, committing the body alone", async () => {
    const l = log();
    const r = plan(
      await run(l, (read, c) =>
        planEdit(read, { id: A, title: "New", sections: { goal: "new goal" } }, c),
      ),
    );
    const path = `docs/issues/items/${A}.md`;
    expect(new TextDecoder().decode(r.replace?.[path]?.bytes)).toBe(
      "# New\n\n## Goal\nnew goal\n\n## Notes\n\n## Done when\nold done\n",
    );
    expect(r.commitScope).toEqual([path]);
    expect(r.trailers).toEqual([["Issue", A]]);
    expect(r.commit).toMatchObject({ action: "edit", title: "New", before: "?1", quote: true });
    expect(r.issue?.title).toBe("New");
  });

  it("adds a heading, says nothing changed, and refuses unknown sections", async () => {
    const l = memory([{ id: A, events: [opened(A, "Old")], body: "no heading\n" }]);
    const r = plan(await run(l, (read, c) => planEdit(read, { id: A, title: "Titled" }, c)));
    expect(new TextDecoder().decode(Object.values(r.replace ?? {})[0]?.bytes)).toBe(
      "# Titled\n\nno heading\n",
    );
    expect(
      plan(await run(l, (read, c) => planEdit(read, { id: A, title: "Titled" }, c))).notes,
    ).toEqual(["nothing changed"]);
    expect(
      await usage(run(log(), (read, c) => planEdit(read, { id: A, sections: { nope: "x" } }, c))),
    ).toContain("has no section nope");
  });

  it("refuses an incomplete body when asked, except on a closed issue", async () => {
    const empty = { id: A, sections: { done: "" } };
    const refused = await run(log(), (read, c) =>
      planEdit(read, empty, c, { refuseIncomplete: true }),
    );
    expect(refused.ok).toBe(false);
    expect(refusedRules(refused).length).toBeGreaterThan(0);
    expect(refusedRules(refused).every((r) => r.startsWith("template/"))).toBe(true);
    const unasked = plan(await run(log(), (read, c) => planEdit(read, empty, c)));
    expect(unasked.findings.map((f) => f.rule)).toEqual(refusedRules(refused));
    const closedLog = memory([{ id: A, events: [opened(A, "Old"), closed(A, "done")], body }]);
    const onClosed = plan(
      await run(closedLog, (read, c) => planEdit(read, empty, c, { refuseIncomplete: true })),
    );
    expect(onClosed.findings).toEqual([]);
  });
});

describe("comment and commit scopes", () => {
  it("comments in any state, and event writes take only the events directory", async () => {
    const l = memory([subject(A, opened(A), closed(A, "done"))]);
    const r = plan(
      await run(l, (read, c) => planComment(read, { id: A, text: "late note", actor: ME }, c)),
    );
    expect(r.commitScope).toEqual([`docs/issues/events/${A}`]);
    expect(r.eventDirs).toEqual([`docs/issues/events/${A}`]);
    expect(r.commit).toMatchObject({ action: "comment on", before: "?1", after: "" });
    expect(
      await usage(run(l, (read, c) => planComment(read, { id: A, text: "  ", actor: ME }, c))),
    ).toBe("the comment text must not be empty");
    expect(
      await usage(
        run(l, (read, c) =>
          planComment(read, { id: A, text: "x".repeat(65 * 1024), actor: ME }, c),
        ),
      ),
    ).toContain("64 KiB");
  });

  it("reach follows links, the parent and duplicate-of from the written issue", async () => {
    const l = memory([
      subject(A, opened(A, "Issue A", C), linked(A, B, "relates-to"), closed(A, "duplicate", D)),
      subject(B, opened(B)),
      subject(C, opened(C), linked(C, X, "depends-on")),
      subject(D, opened(D), linked(D, "adr:0001", "implements")),
      subject(X, opened(X), linked(X, A, "relates-to")),
      subject(E, opened(E)),
    ]);
    const r = plan(
      await run(l, (read, c) => planComment(read, { id: A, text: "note", actor: ME }, c)),
    );
    const read = await l.read();
    const reached = (id: string, refs: string[]) => {
      const s = read.folded.subjects.get(id);
      return {
        dir: `docs/issues/events/${id}`,
        opened: s?.applied.find((a) => a.event.type === "opened")?.path,
        bodies: s?.loaded.bodyPaths,
        template: "docs/issues/templates/task.md",
        refs,
      };
    };
    expect(Object.keys(r.reach).sort()).toEqual([A, B, C, D, X].sort());
    expect(r.reach[A]).toEqual(reached(A, [B, C, D].sort()));
    expect(r.reach[B]).toEqual(reached(B, []));
    expect(r.reach[C]).toEqual(reached(C, [X]));
    expect(r.reach[D]).toEqual(reached(D, []));
    expect(r.reach[X]).toEqual(reached(X, [A]));
    expect(r.reach[A]?.opened).toMatch(/-opened\.yaml$/);
    expect(r.reach[A]?.bodies).toHaveLength(1);
  });
});
