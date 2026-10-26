import type { DecisionView } from "@nikovirtala/adr/kind";
import { MemoryTree, NO_NUMBERING, type Numbering, UsageError } from "@nikovirtala/ledger";
import { createTempRepo } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG } from "./config.js";
import type { IssueView, SourceLog } from "./kind.js";
import {
  type IssuesRead,
  numberingNote,
  openIssueLog,
  readIssues,
  readIssuesFrom,
  readNotes,
  resolveIssue,
  resolveTarget,
} from "./log.js";
import { type DecisionLogRead, sourceLogsOf } from "./sources.js";
import { IDS, issueEvent, issueFiles, LAYOUT, numberingOf, opened } from "./test-support/events.js";
import { arbIssueHistory, TEMPLATE_PATH } from "./test-support/history.js";

const { A, B, C, Z } = IDS;
const D1 = "k3f9q8a1";
const D2 = "m2x7p4d2";
const D_UNFOLDED = "r4tw9xd1";

/** A local decision log with D1 = ADR-0007 (accepted) and D2 (proposed), and an unfolded one. */
function decisionLog(numbering: Numbering = numberingOf({ [D1]: 7 })): DecisionLogRead {
  const view = (id: string, status: string, display: string) =>
    ({ id, status, display, title: `Decision ${id}`, effective: id }) as unknown as DecisionView;
  return {
    root: "docs/adr",
    configPath: null,
    numbering,
    ids: new Set([D1, D2, D_UNFOLDED]),
    views: new Map([
      [D1, view(D1, "accepted", "ADR-0007")],
      [D2, view(D2, "proposed", D2)],
    ]),
  };
}

const PLATFORM: ReadonlyMap<string, SourceLog> = new Map([
  ["platform", { kind: "issues", local: false, subjects: null }],
  ["platform-adr", { kind: "adr", local: false, subjects: null }],
]);

async function readOf(
  o: { numbering?: Numbering; decisions?: DecisionLogRead | null } = {},
): Promise<IssuesRead> {
  const decisions = o.decisions === undefined ? decisionLog() : o.decisions;
  const sources = new Map(sourceLogsOf(decisions, null));
  for (const [k, v] of PLATFORM) sources.set(k, v);
  const files = issueFiles([
    { id: A, events: [opened(A)] },
    { id: B, events: [opened(B)] },
    { id: C, events: [issueEvent(C, "started")], body: "# C\n" },
  ]);
  return readIssuesFrom(new MemoryTree(files), {
    layout: LAYOUT,
    issues: DEFAULT_ISSUES_CONFIG,
    numbering: o.numbering ?? numberingOf({ [A]: 42, [B]: 43 }),
    sources,
    decisions,
    configured: ["platform", "platform-adr"],
  });
}

function refusal(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    return (e as Error).message;
  }
  throw new Error("expected a UsageError");
}

describe("subject arguments", () => {
  it("accept the id, the bare number, ?42 and leading zeros", async () => {
    const read = await readOf();
    for (const input of [A, "42", "?42", "0042", " ?42 "])
      expect(resolveIssue(read, input)).toBe(A);
  });

  it("refuse everything else with exit-2 errors", async () => {
    const read = await readOf();
    expect(refusal(() => resolveIssue(read, "ADR-0007"))).toBe("unknown issue ADR-0007");
    expect(refusal(() => resolveIssue(read, "?44"))).toBe("unknown issue ?44");
    expect(refusal(() => resolveIssue(read, `platform:${A}`))).toBe(
      `platform:${A} is in another log; an issue is changed only in its own log`,
    );
    expect(refusal(() => resolveIssue(read, `issues:${A}`))).toContain("is in another log");
    expect(refusal(() => resolveIssue(read, C))).toBe(
      `${C} has no valid opened event; run issues verify`,
    );
    expect(refusal(() => resolveIssue(read, ""))).toBe('invalid issue ""');
    expect(refusal(() => resolveIssue(read, "x".repeat(65)))).toContain("invalid issue");
    expect(refusal(() => resolveIssue(read, "4\u00002"))).toContain("invalid issue");
  });

  it("say why numbers are unavailable", async () => {
    const read = await readOf({ numbering: { ...NO_NUMBERING, reason: "shallow" } });
    expect(resolveIssue(read, A)).toBe(A);
    expect(refusal(() => resolveIssue(read, "?42"))).toBe(
      "issue numbers are unavailable (shallow clone); use the issue's id instead of ?42",
    );
    expect(numberingNote(read)).toBe(
      "issue numbers are unavailable (shallow clone); issues display by id",
    );
  });
});

describe("relation targets", () => {
  for (const rel of ["depends-on", "part-of", "relates-to"] as const) {
    it(`${rel}: local issues in every form, qualified issues of a configured source`, async () => {
      const read = await readOf();
      for (const input of [A, "42", "?42", "0042"]) expect(resolveTarget(read, input, rel)).toBe(A);
      expect(resolveTarget(read, `platform:${Z}`, rel)).toBe(`platform:${Z}`);
    });

    it(`${rel}: refuses decisions, unknown sources, numbers elsewhere and missing issues`, async () => {
      const read = await readOf();
      expect(refusal(() => resolveTarget(read, "ADR-0007", rel))).toBe(
        `${rel} needs an issue, and ADR-0007 is a decision`,
      );
      expect(refusal(() => resolveTarget(read, `adr:${D1}`, rel))).toContain(
        `${rel} needs an issue`,
      );
      expect(refusal(() => resolveTarget(read, `platform-adr:${D1}`, rel))).toContain(
        "is a decision",
      );
      expect(refusal(() => resolveTarget(read, "platform:?42", rel))).toBe(
        "use the id in platform:?42; numbers in other logs need their history",
      );
      expect(refusal(() => resolveTarget(read, `issues:${A}`, rel))).toBe(
        "unknown source issues; add a [[sources]] entry named issues",
      );
      expect(refusal(() => resolveTarget(read, `gone:${A}`, rel))).toContain("unknown source gone");
      expect(refusal(() => resolveTarget(read, Z, rel))).toBe(`unknown issue ${Z}`);
      expect(refusal(() => resolveTarget(read, C, rel))).toContain("has no valid opened event");
      expect(refusal(() => resolveTarget(read, "", rel))).toBe('invalid target ""');
    });
  }

  it("implements: decisions of the local log by id or number, stored as adr:<id>", async () => {
    const read = await readOf();
    for (const input of [
      D1,
      "7",
      "0007",
      "ADR-0007",
      "adr-7",
      `adr:${D1}`,
      "adr:ADR-0007",
      "adr:7",
    ]) {
      expect(resolveTarget(read, input, "implements"), input).toBe(`adr:${D1}`);
    }
    expect(resolveTarget(read, D2, "implements")).toBe(`adr:${D2}`);
    expect(resolveTarget(read, `platform-adr:${D1}`, "implements")).toBe(`platform-adr:${D1}`);
  });

  it("implements: refuses issues, unknown and unfolded decisions, numbers elsewhere", async () => {
    const read = await readOf();
    expect(refusal(() => resolveTarget(read, "?42", "implements"))).toBe(
      "?42 is an issue; implements needs a decision",
    );
    expect(refusal(() => resolveTarget(read, A, "implements"))).toBe(
      `${A} is an issue; implements needs a decision`,
    );
    expect(refusal(() => resolveTarget(read, `platform:${A}`, "implements"))).toContain(
      "implements needs a decision",
    );
    expect(refusal(() => resolveTarget(read, "ADR-0009", "implements"))).toBe(
      "unknown decision ADR-0009 in docs/adr",
    );
    expect(refusal(() => resolveTarget(read, D_UNFOLDED, "implements"))).toBe(
      `decision ${D_UNFOLDED} doesn't fold; run adr verify`,
    );
    expect(refusal(() => resolveTarget(read, "platform-adr:7", "implements"))).toContain(
      "numbers in other logs need their history",
    );
    expect(refusal(() => resolveTarget(read, `gone:${D1}`, "implements"))).toContain(
      "unknown source gone",
    );
  });

  it("implements: without a decision log, or without its numbers", async () => {
    const none = await readOf({ decisions: null });
    for (const input of [D1, `adr:${D1}`]) {
      expect(refusal(() => resolveTarget(none, input, "implements"))).toBe(
        "no decision log in this repository (docs/adr)",
      );
    }
    const shallow = await readOf({
      decisions: decisionLog({ ...NO_NUMBERING, reason: "shallow" }),
    });
    expect(resolveTarget(shallow, D1, "implements")).toBe(`adr:${D1}`);
    expect(refusal(() => resolveTarget(shallow, "ADR-0007", "implements"))).toBe(
      "decision numbers are unavailable (shallow clone); use the decision's id instead of ADR-0007",
    );
    expect(readNotes(shallow)).toContain(
      "decision numbers are unavailable (shallow clone); decisions display by id",
    );
  });

  it("adds the sources note while other repositories aren't read", async () => {
    expect(readNotes(await readOf())).toContain(
      "references into other repositories (platform, platform-adr) are stored but not checked, and their issues aren't listed, until a newer issues",
    );
  });
});

describe("reading a repository", () => {
  it("reads the work tree, or a --ref commit", async () => {
    await using repo = await createTempRepo({ files: { "README.md": "x\n" } });
    await repo.writeFiles(issueFiles([{ id: A, events: [opened(A, "First")] }]));
    await repo.stage(".");
    const first = await repo.commit("one");
    await repo.writeFiles(issueFiles([{ id: B, events: [opened(B, "Second")] }]));
    const gitOptions = { env: repo.env };
    const work = await readIssues(await openIssueLog({ cwd: repo.root, gitOptions }));
    expect([...work.projection.views.keys()]).toEqual([A, B]);
    expect(work.projection.views.get(A)?.display).toBe("?1");
    expect(work.projection.views.get(B)?.number).toBeNull();
    const old = await readIssues(await openIssueLog({ cwd: repo.root, ref: first, gitOptions }));
    expect([...old.projection.views.keys()]).toEqual([A]);
    expect(old.commit).toBe(first);
    expect(work.decisions).toBeNull();
  });
});

describe("time travel (property)", () => {
  const strip = ({ number: _n, display: _d, ...rest }: IssueView) => rest;

  it("reading --ref <commit k> equals the fold of chunks 1..k", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIssueHistory({ links: true, duplicates: true }).filter((h) => h.steps.length >= 2),
        fc.gen(),
        async (h, g) => {
          const n = g(fc.integer, { min: 2, max: Math.min(5, h.steps.length) });
          const cuts = g(() =>
            fc.uniqueArray(fc.integer({ min: 1, max: h.steps.length - 1 }), {
              minLength: n - 1,
              maxLength: n - 1,
            }),
          ).sort((a, b) => a - b);
          const bounds = [0, ...cuts, h.steps.length];
          await using repo = await createTempRepo({
            files: { [TEMPLATE_PATH]: h.files[TEMPLATE_PATH] ?? "" },
          });
          const bodyOf = new Map(h.subjects.map((s) => [s.id, s.bodyPath]));
          const commits: string[] = [];
          const snapshots: Record<string, string>[] = [];
          const seen: Record<string, string> = { [TEMPLATE_PATH]: h.files[TEMPLATE_PATH] ?? "" };
          for (let k = 0; k + 1 < bounds.length; k++) {
            const chunk = h.steps.slice(bounds[k], bounds[k + 1]);
            const files: Record<string, string> = {};
            for (const s of chunk) {
              files[s.path] = h.files[s.path] ?? "";
              const body = bodyOf.get(s.subject);
              if (s.event.type === "opened" && body !== null && body !== undefined) {
                files[body] = h.files[body] ?? "";
              }
            }
            Object.assign(seen, files);
            await repo.writeFiles(files);
            await repo.stage(".");
            commits.push(await repo.commit(`chunk ${k + 1}`));
            snapshots.push({ ...seen });
          }
          for (const [k, files] of snapshots.entries()) {
            const expected = await readIssuesFrom(new MemoryTree(files), {
              layout: LAYOUT,
              issues: DEFAULT_ISSUES_CONFIG,
              numbering: NO_NUMBERING,
              sources: new Map(),
            });
            const at = await readIssues(
              await openIssueLog({
                cwd: repo.root,
                ref: commits[k] ?? null,
                gitOptions: { env: repo.env },
              }),
            );
            expect([...at.projection.views.values()].map(strip)).toEqual(
              [...expected.projection.views.values()].map(strip),
            );
            expect(at.findings.filter((f) => f.severity === "error")).toEqual([]);
          }
        },
      ),
      { numRuns: 15, endOnFailure: true },
    );
  }, 180_000);
});
