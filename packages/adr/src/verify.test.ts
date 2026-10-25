import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bodyFileName,
  type EventEnvelope,
  type Finding,
  foldChecks,
  MemoryTree,
  newSubjectId,
  nextEventIdentity,
  verifyLog,
  verifySnapshots,
} from "@nikovirtala/ledger";
import {
  createTempRepo,
  danglingAnchor,
  forkAndMerge,
  TEST_HUMAN,
  type TempRepo,
} from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { adrKind } from "./kind.js";
import { openDecisionLog } from "./log.js";
import { indexDecisionLog } from "./log-index.js";
import {
  type AdrHistory,
  adrSupersessionArbs,
  arbAdrHistory,
  TEST_AGENT,
} from "./test-support/decision-arbs.js";
import {
  COMPILED,
  decisionEvent,
  decisionFiles,
  eventFile,
  hashOf,
  LAYOUT,
  proposedData,
} from "./test-support/events.js";
import { adrChecks, verifyDecisions } from "./verify.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

async function repo(files?: Record<string, string>): Promise<TempRepo> {
  const r = await createTempRepo(files === undefined ? {} : { files });
  repos.push(r);
  return r;
}

const open = (r: TempRepo, o: { reader?: "index" } = {}) =>
  openDecisionLog({ cwd: r.root, gitOptions: { env: r.env }, ...o });
const rules = (fs: readonly Finding[]) => fs.map((f) => `${f.rule} ${f.subject}`);

const TEMPLATE = `---
template: nygard
version: 1
sections:
  - id: context
    heading: Context
    required: true
    guidance: Describe the forces.
  - id: scope
    heading: Scope
    required: true
---
# {{title}}

## Context
{{context}}

## Scope
{{scope}}
`;
const BODY = "# Use Aurora\n\n## Context\nWe need SQL.\n\n## Scope\nsrc/orders/**\n";
const A = "a7c2m9xd";
const B = "k3f9q8a1";

/** A log with the template and A accepted, committed on main. */
async function acceptedLog(extra: Record<string, string> = {}): Promise<TempRepo> {
  return repo({
    "docs/adr/templates/nygard.md": TEMPLATE,
    ...decisionFiles([
      {
        id: A,
        body: BODY,
        events: [
          decisionEvent(A, "proposed", { data: proposedData("Use Aurora") }),
          decisionEvent(A, "accepted", { data: { body_sha256: hashOf(BODY) } }),
        ],
      },
    ]),
    ...extra,
  });
}

describe("verifyDecisions", () => {
  it("finds nothing in a clean log, in every mode", async () => {
    const r = await acceptedLog();
    const log = await open(r);
    expect(await verifyDecisions(log, { type: "full" })).toEqual([]);
    expect(await verifyDecisions(log, { type: "full", head: "HEAD" })).toEqual([]);
    expect(await verifyDecisions(log, { type: "range", base: "HEAD" })).toEqual([]);
    expect(await verifyDecisions(await open(r, { reader: "index" }), { type: "staged" })).toEqual(
      [],
    );
  });

  it("finds an edited accepted body in the work tree and in a range", async () => {
    const r = await acceptedLog();
    const base = await r.git.resolveCommit("HEAD");
    await r.write(`docs/adr/decisions/${A}.md`, `${BODY}\nEdited.\n`);
    const log = await open(r);
    // Without a base, only the hash shows the edit.
    expect(rules(await verifyDecisions(log, { type: "full" }))).toEqual([
      `body/hash-mismatch ${A}`,
    ]);
    await r.stage(`docs/adr/decisions/${A}.md`);
    await r.commit("edit");
    expect(rules(await verifyDecisions(log, { type: "range", base: base ?? "" }))).toEqual([
      `body/frozen-modified ${A}`,
      `body/hash-mismatch ${A}`,
    ]);
  });

  it("checks only staged subjects in staged mode, including the draft's template lint", async () => {
    const r = await acceptedLog();
    const [path, content] = eventFile(decisionEvent(A, "rejected", { reason: "late" }));
    const draft = `docs/adr/decisions/${B}.md`;
    const [proposedPath, proposedContent] = eventFile(
      decisionEvent(B, "proposed", { data: proposedData("Draft") }),
    );
    await r.writeFiles({ [path]: content, [draft]: "# Draft\n", [proposedPath]: proposedContent });
    await r.stage(path, draft, proposedPath);
    const findings = await verifyDecisions(await open(r, { reader: "index" }), { type: "staged" });
    expect(findings.map((f) => [f.rule, f.subject, f.message])).toEqual([
      ["template/section-missing", B, "required section Context is missing"],
      ["template/section-missing", B, "required section Scope is missing"],
      ["transition/illegal", A, "rejected is not allowed while accepted"],
    ]);
  });

  it("checks index.md with [log] index = committed, in staged, range and full mode", async () => {
    const r = await acceptedLog({ "docs/adr/adr.toml": '[log]\nindex = "committed"\n' });
    const index = "docs/adr/index.md";
    expect(rules(await verifyDecisions(await open(r), { type: "full" }))).toEqual([
      "index/missing null",
    ]);
    await indexDecisionLog(await open(r), { commit: true });
    const base = (await r.git.resolveCommit("HEAD")) ?? "";
    expect(await verifyDecisions(await open(r), { type: "full", head: "HEAD" })).toEqual([]);

    const text = await readFile(join(r.root, index), "utf8");
    await r.write(index, text.replace("[Use Aurora]", "[Use Aurora!]"));
    const stale = ["index/stale null"];
    expect(rules(await verifyDecisions(await open(r), { type: "full" }))).toEqual(stale);
    await r.stage(index);
    expect(
      rules(await verifyDecisions(await open(r, { reader: "index" }), { type: "staged" })),
    ).toEqual(stale);
    await r.commit("hand edit");
    expect(rules(await verifyDecisions(await open(r), { type: "range", base }))).toEqual(stale);
    expect(rules(await verifyDecisions(await open(r), { type: "full", head: "HEAD" }))).toEqual(
      stale,
    );
    const finding = (await verifyDecisions(await open(r), { type: "full" }))[0];
    expect(finding?.message).toBe(
      "docs/adr/index.md is not what the tool generates; run adr index and commit it",
    );
  });

  it("applies the actor policy from adr.toml", async () => {
    const files = decisionFiles([
      {
        id: B,
        body: BODY,
        events: [
          decisionEvent(B, "proposed", { data: proposedData("Agent") }),
          decisionEvent(B, "accepted", { data: { body_sha256: hashOf(BODY) }, actor: TEST_AGENT }),
        ],
      },
    ]);
    const human = await acceptedLog(files);
    expect(rules(await verifyDecisions(await open(human), { type: "full" }))).toEqual([
      `decision/agent-accepted ${B}`,
    ]);
    const relaxed = await acceptedLog({
      ...files,
      "adr.toml": "[policy]\naccept_requires_human = false\n",
    });
    const log = await open(relaxed);
    expect(await verifyDecisions(log, { type: "full" })).toEqual([]);
    expect(adrChecks(log, null).map((c) => c.id)).toContain("template");
  });

  it("finds a draft whose template is missing", async () => {
    const r = await repo(
      decisionFiles([
        { id: B, body: BODY, events: [decisionEvent(B, "proposed", { data: proposedData("x") })] },
      ]),
    );
    expect(rules(await verifyDecisions(await open(r), { type: "full" }))).toEqual([
      `template/not-found ${B}`,
    ]);
  });
});

// Merge safety (AC 9): a hand-written reference model, independent of adrKind and the fold.

type Status = "proposed" | "accepted" | "rejected" | "withdrawn" | "deprecated" | "superseded";
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

interface RefDecision {
  readonly status: Status;
  readonly accepted: boolean;
  readonly supersededBy: string | null;
}
type Step = { readonly path: string; readonly event: EventEnvelope };

function refStep(r: RefDecision | undefined, e: EventEnvelope): RefDecision | null {
  if (r === undefined) {
    return e.type === "proposed"
      ? { status: "proposed", accepted: false, supersededBy: null }
      : null;
  }
  const to = NEXT[r.status][e.type];
  if (to === undefined) return null;
  return {
    status: to === "same" ? r.status : to,
    accepted: r.accepted || e.type === "accepted",
    supersededBy: e.type === "superseded" ? String(e.data.by) : r.supersededBy,
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Per subject in `(at, id)` order, skipping illegal events. */
function referenceFold(steps: readonly Step[]) {
  const sorted = [...steps].sort(
    (a, b) => cmp(a.event.at, b.event.at) || cmp(a.event.id, b.event.id),
  );
  const subjects = new Map<string, RefDecision>();
  const skipped: Step[] = [];
  for (const s of sorted) {
    const next = refStep(subjects.get(s.event.subject), s.event);
    if (next === null) skipped.push(s);
    else subjects.set(s.event.subject, next);
  }
  return { subjects, skipped };
}

/** The `<rule> <subject>` lines the reference model expects verify to report. */
function referenceLines(steps: readonly Step[]): string[] {
  const { subjects, skipped } = referenceFold(steps);
  const out = skipped.map((s) => `transition/illegal ${s.event.subject}`);
  for (const [id, r] of subjects) {
    if (r.supersededBy !== null && subjects.get(r.supersededBy)?.accepted !== true) {
      out.push(`decision/superseded-by-unaccepted ${id}`);
    }
  }
  const reported = new Set<string>();
  for (const start of subjects.keys()) {
    const path: string[] = [];
    let cur: string | null = start;
    while (cur !== null && !path.includes(cur)) {
      path.push(cur);
      cur = subjects.get(cur)?.supersededBy ?? null;
    }
    if (cur === null) continue;
    const smallest = path.slice(path.indexOf(cur)).sort()[0] ?? "";
    if (!reported.has(smallest)) out.push(`decision/supersession-cycle ${smallest}`);
    reported.add(smallest);
  }
  return out.sort();
}

interface Branch {
  readonly files: Readonly<Record<string, string>>;
  readonly steps: readonly Step[];
}

/**
 * A legal continuation of `h` by the reference table on this branch alone: 1–6 events on existing
 * or new decisions, superseding only decisions accepted on this branch's view. `side` sets the
 * lowest bit of every random byte string's last byte, so ids and file names of the two sides
 * never collide. Events whose id the base or this branch already uses are skipped: generated
 * bytes repeat, and a duplicate id makes the branch illegal.
 */
function branch(g: fc.GeneratorValue, h: AdrHistory, side: 0 | 1): Branch {
  {
    const bytes = (n: number) => {
      const b = g(fc.uint8Array, { minLength: n, maxLength: n });
      b[n - 1] = ((b[n - 1] ?? 0) & 0xfe) | side;
      return (buf: Uint8Array) => buf.set(b);
    };
    const state = referenceFold(h.steps).subjects;
    const history = new Map<string, EventEnvelope[]>();
    for (const { subject, event } of h.steps) {
      history.set(subject, [...(history.get(subject) ?? []), event]);
    }
    const bodies = new Map(
      h.subjects.map((s) => [s.id, s.bodyPath === null ? "" : (h.files[s.bodyPath] ?? "")]),
    );
    const files: Record<string, string> = {};
    const steps: Step[] = [];
    const ids = new Set(h.steps.map((s) => s.event.id));
    let clock = Date.parse(h.steps.at(-1)?.event.at ?? "2001-01-01T00:00:00Z") / 1000;
    const count = g(fc.integer, { min: 1, max: 6 });
    for (let i = 0; i < count; i++) {
      clock += g(fc.integer, { min: 0, max: 3600 });
      let subject: string;
      let type: string;
      let body: { path: string; text: string } | null = null;
      const others = (id: string) => [...state.keys()].filter((x) => x !== id);
      if (state.size === 0 || g(fc.integer, { min: 0, max: 3 }) === 0) {
        subject = newSubjectId(bytes(5));
        if (bodies.has(subject)) continue;
        type = "proposed";
        const text = g(fc.string, { maxLength: 40 });
        body = { path: `${h.layout.root}/decisions/${bodyFileName(subject, "")}`, text };
      } else {
        subject = g(fc.constantFrom, ...state.keys());
        const status = state.get(subject)?.status ?? "proposed";
        const accepted = others(subject).filter((x) => state.get(x)?.status === "accepted");
        const types = Object.keys(NEXT[status]).filter(
          (t) =>
            (t !== "superseded" || accepted.length > 0) &&
            (t !== "linked" || others(subject).length > 0),
        );
        // Prefer supersessions: two branches superseding each other's decisions is how a merge
        // of legal branches produces a cycle.
        const supersede = types.includes("superseded") && g(fc.boolean);
        type = supersede ? "superseded" : g(fc.constantFrom, ...types);
      }
      const data: Record<string, unknown> =
        type === "proposed"
          ? proposedData("branch decision")
          : type === "accepted"
            ? { body_sha256: hashOf(bodies.get(subject) ?? "") }
            : type === "superseded"
              ? {
                  by: g(
                    fc.constantFrom,
                    ...others(subject).filter((x) => state.get(x)?.status === "accepted"),
                  ),
                }
              : type === "noted"
                ? { text: "note" }
                : type === "linked"
                  ? { to: g(fc.constantFrom, ...others(subject)), rel: "relates-to" }
                  : type === "scoped"
                    ? { set: ["src/**"] }
                    : {};
      const { at, id } = nextEventIdentity(history.get(subject) ?? [], {
        now: () => clock * 1000,
        random: bytes(10),
      });
      const event: EventEnvelope = {
        envelope: "ledger/v1",
        kind: adrKind.name,
        schema: adrKind.schema,
        id,
        subject,
        type,
        at,
        actor: TEST_HUMAN,
        ...(type === "rejected" || type === "deprecated" ? { reason: "no longer needed" } : {}),
        data,
      };
      const [path, content] = eventFile(event);
      if (Object.hasOwn(files, path) || Object.hasOwn(h.files, path) || ids.has(id)) continue;
      const next = refStep(state.get(subject), event);
      if (next === null) throw new Error(`generated an illegal ${type}`);
      state.set(subject, next);
      history.set(subject, [...(history.get(subject) ?? []), event]);
      if (body !== null) {
        bodies.set(subject, body.text);
        files[body.path] = body.text;
      }
      files[path] = content;
      ids.add(id);
      steps.push({ path, event });
    }
    return { files, steps };
  }
}

/**
 * Both sides from one generator: two `fc.gen()` arbitraries in a tuple were seen to make the same
 * choices, which would hide every conflict between the sides.
 */
const arbBranches = (h: AdrHistory): fc.Arbitrary<[Branch, Branch]> =>
  fc.gen().map((g) => [branch(g, h, 0), branch(g, h, 1)]);

/**
 * A `GeneratorValue` that replays `script`, one `[arbitrary, value]` pair per call in order, so a
 * test can drive `branch()` through a known counterexample.
 */
function scripted(script: readonly (readonly [unknown, unknown])[]) {
  let i = 0;
  const g = (arb: unknown) => {
    const step = script[i++];
    if (step === undefined || step[0] !== arb) {
      throw new Error(`branch() call ${i} does not match the script`);
    }
    return step[1] instanceof Uint8Array ? step[1].slice() : step[1];
  };
  return { g: g as unknown as fc.GeneratorValue, done: () => i === script.length };
}

/** The base of the AC 9 counterexample found with seed -1819156104: three proposals. */
function counterexampleBase(): AdrHistory {
  const proposed = (id: string, subject: string, at: string, supersedes?: string[]) => ({
    ...decisionEvent(subject, "proposed", { at, data: proposedData("t", supersedes) }),
    id,
  });
  const events = [
    proposed("01AS7PAQ0G00G7BFYH63QR407H", "p02zy1g3", "2016-08-03T07:54:18Z"),
    proposed("01ASA0W03R08R0A1ZRBEXXA0QX", "e3vzhyg4", "2016-08-04T05:36:59Z", ["p02zy1g3"]),
    proposed("01ASA0W03R0HZFY1010T80A7ZZ", "pwj03s05", "2016-08-04T05:36:59Z", ["p02zy1g3"]),
  ];
  const steps = events.map((event) => ({
    subject: event.subject,
    path: eventFile(event)[0],
    event,
  }));
  return {
    kind: adrKind,
    layout: LAYOUT,
    files: decisionFiles(events.map((e) => ({ id: e.subject, events: [e] }))),
    subjects: steps.map(({ subject, path, event }) => ({
      id: subject,
      bodyPath: null,
      frozen: false,
      events: [{ path, event }],
    })),
    steps,
  };
}

const eventIds = (h: AdrHistory, b: Branch) => [...h.steps, ...b.steps].map((s) => s.event.id);

/** Bases with several accepted decisions, so both branches can supersede one of them. */
const proposeAndAccept = {
  ...adrSupersessionArbs,
  superseded: () => null,
};

const merges = () =>
  fc
    .oneof(
      arbAdrHistory({ maxSteps: 12 }),
      arbAdrHistory({ data: proposeAndAccept, subjects: { min: 2, max: 4 }, maxSteps: 8 }),
    )
    .chain((h) => arbBranches(h).map(([left, right]) => [h, left, right] as const));
const expectedOf = (h: AdrHistory, left: Branch, right: Branch) =>
  referenceLines([...h.steps, ...left.steps, ...right.steps]);
const checks = foldChecks(adrKind, { templates: null });

/** The git-backed properties spawn a few hundred git processes; allow for a loaded machine. */
const GIT_PROPERTY_TIMEOUT = 120_000;

describe("merge safety (AC 9)", () => {
  it("reports an error exactly when the reference model rejects the merged history", async () => {
    await fc.assert(
      fc.asyncProperty(merges(), async ([h, left, right]) => {
        const merged = { ...h.files, ...left.files, ...right.files };
        const want = expectedOf(h, left, right);
        for (const [base, scope] of [
          [null, "all"],
          [new MemoryTree(h.files), "all"],
          [new MemoryTree(h.files), "changed"],
        ] as const) {
          const findings = await verifySnapshots({
            kind: COMPILED,
            layout: LAYOUT,
            base,
            head: new MemoryTree(merged),
            scope,
            checks,
          });
          expect(findings.some((f) => f.severity === "error")).toBe(want.length > 0);
          expect(rules(findings).sort()).toEqual(want);
        }
      }),
    );
  });

  it("sees clean merges, illegal events and supersession cycles", () => {
    // The property above must see each outcome, or it would pass vacuously.
    const samples = fc.sample(merges(), { numRuns: 300, seed: 11 });
    const lines = samples.flatMap(([h, l, r]) => expectedOf(h, l, r));
    expect(samples.some(([h, l, r]) => expectedOf(h, l, r).length === 0)).toBe(true);
    expect(lines.some((x) => x.startsWith("transition/illegal "))).toBe(true);
    expect(lines.some((x) => x.startsWith("decision/supersession-cycle "))).toBe(true);
  });

  it("never reuses a base event id on a branch (seed -1819156104, run 45)", () => {
    // The right side notes p02zy1g3 in the base's last second with the random bytes of the
    // base's pwj03s05 proposal, so the note's id was 01ASA0W03R0HZFY1010T80A7ZZ too.
    const h = counterexampleBase();
    const { g, done } = scripted([
      [fc.integer, 1], // events
      [fc.integer, 0], // clock step
      [fc.integer, 1], // an existing decision
      [fc.constantFrom, "p02zy1g3"],
      [fc.constantFrom, "noted"],
      [fc.uint8Array, Uint8Array.of(4, 126, 255, 4, 1, 6, 144, 5, 31, 255)],
    ]);
    const right = branch(g, h, 1);
    expect(done()).toBe(true);
    const ids = eventIds(h, right);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never reuses an event id within a branch (seed -1819156104, shrunk)", () => {
    // Two new decisions in the same second from all-zero bytes: both ids were
    // 01ASA0W03R0000000000000000, under subjects 00000000 and 00000002.
    const h = counterexampleBase();
    const zeros = new Uint8Array(10);
    const { g, done } = scripted([
      [fc.integer, 2], // events
      [fc.integer, 0], // clock step
      [fc.integer, 0], // a new decision
      [fc.uint8Array, Uint8Array.of(0, 0, 0, 0, 0)],
      [fc.string, ""],
      [fc.uint8Array, zeros],
      [fc.integer, 0],
      [fc.integer, 0],
      [fc.uint8Array, Uint8Array.of(0, 0, 0, 0, 2)],
      [fc.string, ""],
      [fc.uint8Array, zeros],
    ]);
    const left = branch(g, h, 0);
    expect(done()).toBe(true);
    const ids = eventIds(h, left);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(
    "holds for real merges and rebases with forkAndMerge",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          merges(),
          fc.constantFrom("merge" as const, "rebase" as const),
          async ([h, left, right], strategy) => {
            const r = await repo(h.files);
            const res = await forkAndMerge(r, {
              left: (t) => t.writeFiles(left.files),
              right: (t) => t.writeFiles(right.files),
              strategy,
            });
            const findings = await verifyLog({
              git: r.git,
              kind: adrKind,
              layout: LAYOUT,
              mode: { type: "range", base: res.base, head: "HEAD" },
              checks,
            });
            expect(rules(findings).sort()).toEqual(expectedOf(h, left, right));
          },
        ),
        { numRuns: 10 },
      );
    },
    GIT_PROPERTY_TIMEOUT,
  );
});

// 01:387, design 2b §4.8: a dangling anchor is a verifier mutation that needs git grep, so it runs
// on temp repos rather than the MemoryTree tamper properties.
describe("dangling anchors", () => {
  it(
    "are reported exactly when a code file names a decision the log lacks",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbAdrHistory({ maxSteps: 8 }), fc.integer(), async (h, seed) => {
          const r = await repo(h.files);
          const ids = h.subjects.map((s) => s.id);
          const live = ids.length === 0 ? "" : `// adr:${ids[0]}\n`;
          await r.write("src/live.ts", live);
          const missing = async () =>
            (await verifyDecisions(await open(r), { type: "full" }))
              .filter((f) => f.rule === "scope/anchor-missing")
              .map((f) => [f.file, f.line, f.subject]);
          expect(await missing()).toEqual([]);
          const d = danglingAnchor({ keyword: "adr", taken: new Set(ids), seed });
          await r.write(d.path, d.text);
          expect(await missing()).toEqual([[d.path, 1, d.id]]);
        }),
        { numRuns: 10 },
      );
    },
    GIT_PROPERTY_TIMEOUT,
  );
});
