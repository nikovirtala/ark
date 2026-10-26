import {
  type Actor,
  type EventEnvelope,
  type FoldedLogOf,
  type KindFinding,
  kindFindings,
} from "@nikovirtala/ledger";
import { TEST_HUMAN } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { type IssueOptions, issueKind, type SourceLog } from "../kind.js";
import { TEST_AGENT } from "../test-support/arbitraries.js";
import {
  foldFiles,
  IDS,
  issueEvent,
  issueFiles,
  opened,
  type SubjectSpec,
} from "../test-support/events.js";

const { A, B, C, D, X, Z } = IDS;
const OPTIONS: IssueOptions = { ...issueKind.def.options, exclusive: ["priority", "type"] };

const closed = (
  id: string,
  resolution: string,
  o: { reason?: string; of?: string; actor?: Actor } = {},
) =>
  issueEvent(id, "closed", {
    data: { resolution, ...(o.of === undefined ? {} : { of: o.of }) },
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    ...(o.actor === undefined ? {} : { actor: o.actor }),
  });
const linked = (id: string, to: string, rel: string) =>
  issueEvent(id, "linked", { data: { to, rel } });
const unlinked = (id: string, to: string, rel: string) =>
  issueEvent(id, "unlinked", { data: { to, rel } });
const labeled = (id: string, set: string[]) => issueEvent(id, "labeled", { data: { set } });
const subject = (id: string, ...events: EventEnvelope[]): SubjectSpec => ({ id, events });

async function logOf(...subjects: SubjectSpec[]): Promise<FoldedLogOf<typeof issueKind>> {
  return foldFiles(issueFiles(subjects));
}

/** Every kind finding of the log: invariants per folded subject, then relate. */
function kindOf(
  log: FoldedLogOf<typeof issueKind>,
  options: IssueOptions = OPTIONS,
): KindFinding[] {
  const out: KindFinding[] = [];
  for (const s of log.subjects.values()) {
    if (s.status !== null) out.push(...(issueKind.def.invariants?.(s, options) ?? []));
  }
  out.push(...(issueKind.def.relate?.(log, options) ?? []));
  return out;
}

const rules = (fs: readonly KindFinding[]) => fs.map((f) => `${f.rule} ${f.subject}`).sort();

async function rulesOf(subjects: SubjectSpec[], options: IssueOptions = OPTIONS) {
  return rules(kindOf(await logOf(...subjects), options));
}

describe("closed conditions", () => {
  const cases: [string, Parameters<typeof closed>[2] & { resolution: string }, string[]][] = [
    ["done without a reason", { resolution: "done" }, []],
    ["wontfix with a reason", { resolution: "wontfix", reason: "no" }, []],
    ["wontfix without a reason", { resolution: "wontfix" }, ["issue/reason-required"]],
    [
      "obsolete with a blank reason",
      { resolution: "obsolete", reason: "  " },
      ["issue/reason-required"],
    ],
    ["duplicate with a reason", { resolution: "duplicate", of: B, reason: "same" }, []],
    ["duplicate without a reason", { resolution: "duplicate", of: B }, ["issue/reason-required"]],
    ["done with of", { resolution: "done", of: B }, ["issue/of-without-duplicate"]],
    [
      "duplicate of itself",
      { resolution: "duplicate", of: A, reason: "x" },
      ["issue/self-reference"],
    ],
  ];
  for (const [name, o, expected] of cases) {
    it(name, async () => {
      const e = closed(A, o.resolution, o);
      const fs = kindOf(await logOf(subject(A, opened(A), e), subject(B, opened(B))));
      const own = fs.filter((f) => f.subject === A && f.severity === "error");
      expect(own.map((f) => f.rule)).toEqual(expected);
      for (const f of own) expect(f.event).toBe(e.id);
    });
  }

  it("checks every applied closed event, not only the current one", async () => {
    const first = closed(A, "wontfix");
    const reopened = issueEvent(A, "reopened", { reason: "again" });
    const fs = kindOf(await logOf(subject(A, opened(A), first, reopened)));
    expect(fs.map((f) => [f.rule, f.event])).toEqual([["issue/reason-required", first.id]]);
  });

  it("names the resolution in the message", async () => {
    const fs = kindOf(await logOf(subject(A, opened(A), closed(A, "wontfix"))));
    expect(fs[0]?.message).toBe("closed as won't fix without a reason");
  });
});

describe("agent policy, every actor × event × config", () => {
  const configs: [boolean, boolean][] = [
    [false, true],
    [false, false],
    [true, true],
    [true, false],
  ];
  const forbids = (requiresHuman: boolean, canClose: boolean) => requiresHuman || !canClose;
  const resolutions = ["done", "wontfix", "obsolete", "duplicate"];
  for (const [requiresHuman, canClose] of configs) {
    const options = { ...OPTIONS, closeRequiresHuman: requiresHuman, mcpCanClose: canClose };
    const label = `close_requires_human=${requiresHuman} mcp_can_close=${canClose}`;
    for (const actor of [TEST_HUMAN, TEST_AGENT]) {
      for (const resolution of resolutions) {
        for (const reason of [undefined, "it is done"]) {
          const name = `${label}: ${actor.kind} closes as ${resolution}${reason === undefined ? " without a reason" : " with a reason"}`;
          it(name, async () => {
            const e = closed(A, resolution, {
              actor,
              ...(reason === undefined ? {} : { reason }),
              ...(resolution === "duplicate" ? { of: B } : {}),
            });
            const got = await rulesOf([subject(A, opened(A), e), subject(B, opened(B))], options);
            const expected: string[] = [];
            if (resolution !== "done" && reason === undefined)
              expected.push("issue/reason-required");
            if (actor.kind === "agent" && forbids(requiresHuman, canClose)) {
              expected.push("issue/agent-closed");
            }
            if (actor.kind === "agent" && reason === undefined) {
              expected.push("issue/agent-reason-required");
            }
            expect(got).toEqual(expected.map((r) => `${r} ${A}`).sort());
          });
        }
      }
      it(`${label}: ${actor.kind} reopens and does everything else`, async () => {
        const events = [
          opened(A),
          issueEvent(A, "started", { actor }),
          issueEvent(A, "stopped", { actor }),
          closed(A, "done", { reason: "done", actor: TEST_HUMAN }),
          issueEvent(A, "reopened", { reason: "again", actor }),
          issueEvent(A, "assigned", { data: { set: ["a@example.com"] }, actor }),
          issueEvent(A, "labeled", { data: { set: ["type:bug"] }, actor }),
          issueEvent(A, "commented", { data: { text: "hi" }, actor }),
          issueEvent(A, "linked", { data: { to: B, rel: "relates-to" }, actor }),
          issueEvent(A, "unlinked", { data: { to: B, rel: "relates-to" }, actor }),
          issueEvent(A, "scoped", { data: { set: ["src/**"] }, actor }),
        ];
        expect(await rulesOf([subject(A, ...events), subject(B, opened(B))], options)).toEqual([]);
      });
    }
  }

  it("names the agent and the policy key", async () => {
    const e = closed(A, "done", { actor: TEST_AGENT, reason: "done" });
    const fs = kindOf(await logOf(subject(A, opened(A), e)), {
      ...OPTIONS,
      closeRequiresHuman: true,
    });
    expect(fs.map((f) => f.message)).toEqual([
      "closed as done by agent test-agent; close_requires_human = true needs a human",
    ]);
    const off = kindOf(await logOf(subject(A, opened(A), e)), { ...OPTIONS, mcpCanClose: false });
    expect(off.map((f) => f.message)).toEqual([
      "closed as done by agent test-agent; mcp_can_close = false forbids agent closes",
    ]);
  });
});

describe("label exclusivity", () => {
  it("reports two labels with one exclusive prefix in the current set", async () => {
    const e = labeled(A, ["priority:high", "priority:low", "type:bug"]);
    const fs = kindOf(await logOf(subject(A, opened(A), e)));
    expect(fs.map((f) => [f.rule, f.event, f.message])).toEqual([
      [
        "issue/label-exclusive",
        e.id,
        "labels priority:high, priority:low share the exclusive prefix priority",
      ],
    ]);
  });

  it("compares prefixes exactly, and ignores prefixes that aren't exclusive", async () => {
    expect(
      await rulesOf([subject(A, opened(A), labeled(A, ["Priority:high", "priority:low"]))]),
    ).toEqual([]);
    expect(await rulesOf([subject(A, opened(A), labeled(A, ["area:cli", "area:mcp"]))])).toEqual(
      [],
    );
  });

  it("checks only the latest labeled set", async () => {
    const bad = () => labeled(A, ["type:bug", "type:feature"]);
    const good = () => labeled(A, ["type:bug"]);
    const first = bad();
    expect(await rulesOf([subject(A, opened(A), first, good())])).toEqual([]);
    const second = good();
    expect(await rulesOf([subject(A, opened(A), second, bad())])).toEqual([
      `issue/label-exclusive ${A}`,
    ]);
  });

  it("reports a set that a newly exclusive prefix breaks", async () => {
    const s = [subject(A, opened(A), labeled(A, ["area:cli", "area:mcp"]))];
    expect(await rulesOf(s, { ...OPTIONS, exclusive: ["area"] })).toEqual([
      `issue/label-exclusive ${A}`,
    ]);
  });
});

describe("relations, the verify column", () => {
  const adrSources = (subjects: Record<string, string>): ReadonlyMap<string, SourceLog> =>
    new Map([
      [
        "adr",
        {
          kind: "adr" as const,
          local: true,
          subjects: new Map(
            Object.entries(subjects).map(([id, status]) => [
              id,
              { status, display: id, title: "A decision", effective: id },
            ]),
          ),
        },
      ],
      ["platform", { kind: "issues" as const, local: false, subjects: null }],
    ]);
  const withSources = {
    ...OPTIONS,
    sources: adrSources({ k3f9q8a1: "accepted", m2x7p4d2: "proposed" }),
  };

  for (const rel of ["depends-on", "part-of", "relates-to"]) {
    it(`${rel}: a self-link is issue/self-reference on the linked event`, async () => {
      const e = linked(A, A, rel);
      const fs = kindOf(await logOf(subject(A, opened(A), e)));
      expect(fs.map((f) => [f.rule, f.event])).toEqual([["issue/self-reference", e.id]]);
    });

    it(`${rel}: a missing target is issue/reference-missing`, async () => {
      const fs = kindOf(await logOf(subject(A, opened(A), linked(A, Z, rel))));
      expect(fs.map((f) => [f.rule, f.message])).toEqual([
        ["issue/reference-missing", `${rel} ${Z}, which is not in the log`],
      ]);
    });

    it(`${rel}: an unfolded target is issue/reference-missing`, async () => {
      const fs = kindOf(
        await logOf(subject(A, opened(A), linked(A, B, rel)), {
          id: B,
          events: [issueEvent(B, "started")],
          body: "# B\n",
        }),
      );
      expect(fs.map((f) => [f.rule, f.message])).toEqual([
        ["issue/reference-missing", `${rel} ${B}, which has no valid opened event`],
      ]);
    });

    it(`${rel}: a decision target is issue/target-kind`, async () => {
      const fs = kindOf(
        await logOf(subject(A, opened(A), linked(A, "adr:k3f9q8a1", rel))),
        withSources,
      );
      expect(fs.map((f) => f.rule)).toEqual(["issue/target-kind"]);
    });

    it(`${rel}: an unknown source is issue/unknown-source; own-name issues: too`, async () => {
      for (const to of [`gone:${B}`, `issues:${B}`]) {
        const fs = kindOf(await logOf(subject(A, opened(A), linked(A, to, rel))), withSources);
        expect(fs.map((f) => f.rule)).toEqual(["issue/unknown-source"]);
      }
    });

    it(`${rel}: a configured issues source is stored unchecked`, async () => {
      const fs = kindOf(
        await logOf(subject(A, opened(A), linked(A, `platform:${B}`, rel))),
        withSources,
      );
      expect(fs).toEqual([]);
    });

    it(`${rel}: a duplicate link is folded once, with no finding`, async () => {
      const log = await logOf(
        subject(A, opened(A), linked(A, B, rel), linked(A, B, rel)),
        subject(B, opened(B)),
      );
      expect(log.subjects.get(A)?.state?.links).toHaveLength(1);
      expect(kindOf(log)).toEqual([]);
    });
  }

  it("implements: a local issue is issue/target-kind", async () => {
    const fs = kindOf(
      await logOf(subject(A, opened(A), linked(A, B, "implements")), subject(B, opened(B))),
    );
    expect(fs.map((f) => f.rule)).toEqual(["issue/target-kind"]);
  });

  it("implements: an accepted decision is clean, a proposed one warns, a missing one errors", async () => {
    const fs = kindOf(
      await logOf(
        subject(
          A,
          opened(A),
          linked(A, "adr:k3f9q8a1", "implements"),
          linked(A, "adr:m2x7p4d2", "implements"),
          linked(A, "adr:r4tw9xd1", "implements"),
        ),
      ),
      withSources,
    );
    expect(fs.map((f) => [f.severity, f.rule, f.message])).toEqual([
      ["warning", "issue/implements-unaccepted", "implements adr:m2x7p4d2, which is proposed"],
      ["error", "issue/reference-missing", "implements adr:r4tw9xd1, which is not in source adr"],
    ]);
  });

  it("implements: names the decision in force for a superseded decision", async () => {
    const sources: ReadonlyMap<string, SourceLog> = new Map([
      [
        "adr",
        {
          kind: "adr" as const,
          local: true,
          subjects: new Map([
            [
              "k3f9q8a1",
              { status: "superseded", display: "ADR-0001", title: "x", effective: "m2x7p4d2" },
            ],
          ]),
        },
      ],
    ]);
    const fs = kindOf(await logOf(subject(A, opened(A), linked(A, "adr:k3f9q8a1", "implements"))), {
      ...OPTIONS,
      sources,
    });
    expect(fs.map((f) => f.message)).toEqual([
      "implements adr:k3f9q8a1, which is superseded; the decision in force is adr:m2x7p4d2",
    ]);
  });

  it("implements: adr: without a local decision log is an unknown source", async () => {
    const sources: ReadonlyMap<string, SourceLog> = new Map();
    const fs = kindOf(await logOf(subject(A, opened(A), linked(A, "adr:k3f9q8a1", "implements"))), {
      ...OPTIONS,
      sources,
    });
    expect(fs.map((f) => [f.rule, f.message])).toEqual([
      [
        "issue/unknown-source",
        "implements adr:k3f9q8a1: no decision log in this repository (docs/adr)",
      ],
    ]);
  });

  it("checks no qualified reference when sources aren't read", async () => {
    const fs = kindOf(await logOf(subject(A, opened(A), linked(A, `gone:${B}`, "depends-on"))));
    expect(fs).toEqual([]);
  });

  it("a cycle of raw depends-on edges is issue/cycle", async () => {
    expect(
      await rulesOf([
        subject(A, opened(A), linked(A, B, "depends-on")),
        subject(B, opened(B), linked(B, A, "depends-on")),
      ]),
    ).toEqual([`issue/cycle ${A}`]);
  });

  it("relates-to and implements may form cycles", async () => {
    expect(
      await rulesOf([
        subject(A, opened(A), linked(A, B, "relates-to")),
        subject(B, opened(B), linked(B, A, "relates-to")),
      ]),
    ).toEqual([]);
  });

  it("a cycle only through a duplicate's canonical issue is issue/cycle", async () => {
    // A → B, B is a duplicate of C, C → A.
    const log = await logOf(
      subject(A, opened(A), linked(A, B, "depends-on")),
      subject(B, opened(B), closed(B, "duplicate", { of: C, reason: "same" })),
      subject(C, opened(C), linked(C, A, "depends-on")),
    );
    const fs = kindOf(log).filter((f) => f.rule === "issue/cycle");
    expect(fs.map((f) => [f.subject, f.message, f.related])).toEqual([
      [A, `depends-on cycle: ${A} → ${C} (via duplicate ${B}) → ${A}`, [B, C]],
    ]);
  });

  it("an effective edge's related names every duplicate it goes through", async () => {
    // E depends on D, D is a duplicate of P, P a duplicate of E: E → E via D and P.
    const [E, P] = [IDS.E, IDS.F];
    const log = await logOf(
      subject(E, opened(E), linked(E, D, "depends-on")),
      subject(D, opened(D), closed(D, "duplicate", { of: P, reason: "same" })),
      subject(P, opened(P), closed(P, "duplicate", { of: E, reason: "same" })),
    );
    const fs = kindOf(log).filter((f) => f.rule === "issue/cycle");
    expect(fs.map((f) => [f.subject, f.message, f.related])).toEqual([
      [E, `depends-on cycle: ${E} → ${E} (via duplicate ${D})`, [D, P]],
    ]);
  });

  it("the effective self-loop is issue/cycle on X, on its linked event", async () => {
    // X depends on S, S is a duplicate of X.
    const S = B;
    const link = linked(X, S, "depends-on");
    const log = await logOf(
      subject(X, opened(X), link),
      subject(S, opened(S), closed(S, "duplicate", { of: X, reason: "same" })),
    );
    const fs = kindOf(log);
    expect(fs.map((f) => [f.rule, f.subject, f.message, f.event, f.related])).toEqual([
      ["issue/cycle", X, `depends-on cycle: ${X} → ${X} (via duplicate ${S})`, link.id, [S]],
    ]);
  });

  it("a part-of cycle is issue/cycle, and part-of doesn't follow duplicates", async () => {
    expect(
      await rulesOf([
        subject(A, opened(A), linked(A, B, "part-of")),
        subject(B, opened(B), linked(B, A, "part-of")),
      ]),
    ).toEqual([`issue/cycle ${A}`]);
    const log = await logOf(
      subject(A, opened(A), linked(A, B, "part-of")),
      subject(B, opened(B), closed(B, "duplicate", { of: C, reason: "same" })),
      subject(C, opened(C), linked(C, A, "part-of")),
    );
    expect(rules(kindOf(log).filter((f) => f.severity === "error"))).toEqual([]);
  });

  it("a second parent is issue/multiple-parents on the latest part-of link", async () => {
    const second = linked(A, C, "part-of");
    const fs = kindOf(
      await logOf(
        {
          id: A,
          events: [opened(A, "A", B), second],
        },
        subject(B, opened(B)),
        subject(C, opened(C)),
      ),
    );
    expect(fs.map((f) => [f.rule, f.event, f.message, f.related])).toEqual([
      ["issue/multiple-parents", second.id, `part of more than one issue: ${B}, ${C}`, [B, C]],
    ]);
  });

  it("unlinking the parent from opened.parent clears it", async () => {
    const log = await logOf(
      {
        id: A,
        events: [opened(A, "A", B), unlinked(A, B, "part-of"), linked(A, C, "part-of")],
      },
      subject(B, opened(B)),
      subject(C, opened(C)),
    );
    expect(kindOf(log)).toEqual([]);
    expect(log.subjects.get(A)?.state?.links.map((l) => l.to)).toEqual([C]);
  });

  it("a duplicate of a duplicate is an error; a missing of is reference-missing", async () => {
    expect(
      await rulesOf([
        subject(A, opened(A), closed(A, "duplicate", { of: B, reason: "same" })),
        subject(B, opened(B), closed(B, "duplicate", { of: C, reason: "same" })),
        subject(C, opened(C)),
      ]),
    ).toEqual([`issue/duplicate-of-duplicate ${A}`]);
    expect(
      await rulesOf([subject(A, opened(A), closed(A, "duplicate", { of: Z, reason: "same" }))]),
    ).toEqual([`issue/reference-missing ${A}`]);
  });

  it("closing with open children warns for any resolution", async () => {
    for (const resolution of ["done", "wontfix"]) {
      const fs = kindOf(
        await logOf(subject(A, opened(A), closed(A, resolution, { reason: "x" })), {
          id: B,
          events: [opened(B, "B", A)],
        }),
      );
      expect(fs.map((f) => [f.severity, f.rule, f.related])).toEqual([
        ["warning", "issue/closed-with-open-children", [B]],
      ]);
    }
  });

  it("closing as done with open dependencies warns; other resolutions don't", async () => {
    const dep = subject(B, opened(B));
    const done = kindOf(
      await logOf(subject(A, opened(A), linked(A, B, "depends-on"), closed(A, "done")), dep),
    );
    expect(done.map((f) => [f.severity, f.rule])).toEqual([
      ["warning", "issue/closed-with-open-dependencies"],
    ]);
    const wontfix = kindOf(
      await logOf(
        subject(A, opened(A), linked(A, B, "depends-on"), closed(A, "wontfix", { reason: "x" })),
        dep,
      ),
    );
    expect(wontfix).toEqual([]);
  });

  it("closed-with-open-dependencies relates the duplicates behind a blocker", async () => {
    // A depends on B, B is a duplicate of D, D a duplicate of C, and C is open.
    const fs = kindOf(
      await logOf(
        subject(A, opened(A), linked(A, B, "depends-on"), closed(A, "done")),
        subject(B, opened(B), closed(B, "duplicate", { of: D, reason: "same" })),
        subject(C, opened(C)),
        subject(D, opened(D), closed(D, "duplicate", { of: C, reason: "same" })),
      ),
    ).filter((f) => f.rule === "issue/closed-with-open-dependencies");
    expect(fs.map((f) => [f.subject, f.message, f.related])).toEqual([
      [A, `closed as done while it depends on ${C}, which are not closed`, [B, C, D]],
    ]);
  });

  it("a closed or in-progress source follows the same rules as an open one", async () => {
    expect(
      await rulesOf([
        subject(A, opened(A), issueEvent(A, "started"), linked(A, Z, "depends-on")),
        subject(B, opened(B), closed(B, "done"), linked(B, Z, "relates-to")),
      ]),
    ).toEqual([`issue/reference-missing ${A}`, `issue/reference-missing ${B}`]);
  });
});

describe("issue/cycle, one finding per strongly connected component", () => {
  it("two cycles sharing a node are one finding on the smallest id", async () => {
    const ab = linked(A, B, "depends-on");
    const fs = kindOf(
      await logOf(
        subject(A, opened(A), ab, linked(A, C, "depends-on")),
        subject(B, opened(B), linked(B, A, "depends-on")),
        subject(C, opened(C), linked(C, A, "depends-on")),
      ),
    );
    expect(fs.map((f) => [f.rule, f.subject, f.related, f.message, f.event])).toEqual([
      ["issue/cycle", A, [B, C], `depends-on cycle: ${A} → ${B} → ${A}`, ab.id],
    ]);
  });

  it("two disjoint cycles are two findings", async () => {
    expect(
      await rulesOf([
        subject(A, opened(A), linked(A, B, "depends-on")),
        subject(B, opened(B), linked(B, A, "depends-on")),
        subject(C, opened(C), linked(C, D, "depends-on")),
        subject(D, opened(D), linked(D, C, "depends-on")),
      ]),
    ).toEqual([`issue/cycle ${A}`, `issue/cycle ${C}`]);
  });

  it("a part-of cycle whose first edge comes from opened.parent names the opened event", async () => {
    const o = opened(A, "A", B);
    const fs = kindOf(
      await logOf({ id: A, events: [o] }, subject(B, opened(B), linked(B, A, "part-of"))),
    );
    expect(fs.map((f) => [f.rule, f.event, f.message])).toEqual([
      ["issue/cycle", o.id, `part-of cycle: ${A} → ${B} → ${A}`],
    ]);
  });

  it("an effective edge's finding names the linked event of X → T", async () => {
    const xt = linked(A, B, "depends-on");
    const fs = kindOf(
      await logOf(
        subject(A, opened(A), xt),
        subject(B, opened(B), closed(B, "duplicate", { of: C, reason: "same" })),
        subject(C, opened(C), linked(C, A, "depends-on")),
      ),
    );
    expect(fs.find((f) => f.rule === "issue/cycle")?.event).toBe(xt.id);
  });
});

describe("finding identity", () => {
  const key = (log: FoldedLogOf<typeof issueKind>) =>
    kindFindings(log, kindOf(log)).map((f) => [f.rule, f.subject, f.file, f.message].join("|"));

  it("a second labeled that keeps a clash gives a new key; a comment doesn't", async () => {
    const first = labeled(A, ["type:bug", "type:feature"]);
    const before = key(await logOf(subject(A, opened(A), first)));
    const relabeled = key(
      await logOf(
        subject(A, opened(A), first, labeled(A, ["area:cli", "type:bug", "type:feature"])),
      ),
    );
    const commented = key(
      await logOf(
        subject(A, opened(A), first, issueEvent(A, "commented", { data: { text: "x" } })),
      ),
    );
    expect(before).toHaveLength(1);
    expect(relabeled).toHaveLength(1);
    expect(relabeled).not.toEqual(before);
    expect(commented).toEqual(before);
  });
});
