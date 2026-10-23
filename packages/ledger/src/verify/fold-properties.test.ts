import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import type { Finding } from "../findings/finding.js";
import { foldLog } from "../fold/fold.js";
import { MemoryTree, refReader, type TreeReader } from "../git/tree.js";
import { bodyFileName } from "../identity/files.js";
import { bodySha256 } from "../identity/hash.js";
import { newSubjectId } from "../identity/ids.js";
import { eventPath } from "../identity/layout.js";
import { loadLog } from "../log/snapshot.js";
import { nextEventIdentity } from "../log/write.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { forkAndMerge } from "../testing/fork-and-merge.js";
import {
  arbLegalHistory,
  type DataArbs,
  type LegalHistory,
  TEST_HUMAN,
} from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { verifyLog, verifySnapshots } from "./verify.js";

type Widget = typeof kind;
type History = LegalHistory<Widget>;

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

const data: DataArbs<Widget> = {
  created: () => fc.record({ title: fc.string({ minLength: 1, maxLength: 20 }) }),
  noted: () => fc.record({ text: fc.string({ minLength: 1, maxLength: 20 }) }),
  published: () => fc.constant({}),
  retired: () => fc.constant({}),
  revived: () => fc.constant({}),
};
const histories = (o: { maxSteps?: number } = {}) =>
  arbLegalHistory(kind, { data, body: () => fc.string({ maxLength: 80 }), ...o });
const compiled = compileKind(kind);
const encoder = new TextEncoder();
const hashOf = (text: string) => bodySha256(encoder.encode(text));

type Status = "draft" | "published" | "retired";

/** The widget lifecycle as a hand-written table, independent of `defineKind` and the fold. */
const NEXT: Readonly<Record<Status, Readonly<Record<string, Status | null>>>> = {
  draft: { noted: null, published: "published" },
  published: { noted: null, retired: "retired" },
  retired: { noted: null, revived: "published" },
};

interface RefSubject {
  readonly status: Status;
  readonly title: string;
  readonly notes: number;
  readonly revivals: number;
  readonly applied: readonly string[];
}

/** One reference step; `null` when the event is illegal in `r`'s status. */
function refStep(r: RefSubject | undefined, e: EventEnvelope): RefSubject | null {
  const applied = [...(r?.applied ?? []), e.id];
  if (r === undefined) {
    return e.type === "created"
      ? { status: "draft", title: String(e.data.title), notes: 0, revivals: 0, applied }
      : null;
  }
  const row = NEXT[r.status];
  if (!Object.hasOwn(row, e.type)) return null;
  const to = row[e.type] ?? r.status;
  return {
    ...r,
    status: to,
    notes: r.notes + (e.type === "noted" ? 1 : 0),
    revivals: r.revivals + (e.type === "revived" ? 1 : 0),
    applied,
  };
}

/** The reference fold of a set of events: per subject in `(at, id)` order, skipping illegal ones. */
function referenceFold(events: readonly { path: string; event: EventEnvelope }[]): {
  subjects: Map<string, RefSubject>;
  skipped: string[];
} {
  const sorted = [...events].sort((a, b) =>
    a.event.at !== b.event.at
      ? a.event.at < b.event.at
        ? -1
        : 1
      : a.event.id < b.event.id
        ? -1
        : a.event.id > b.event.id
          ? 1
          : 0,
  );
  const subjects = new Map<string, RefSubject>();
  const skipped: string[] = [];
  for (const { path, event } of sorted) {
    const next = refStep(subjects.get(event.subject), event);
    if (next === null) skipped.push(path);
    else subjects.set(event.subject, next);
  }
  return { subjects, skipped: skipped.sort() };
}

interface Branch {
  readonly files: Readonly<Record<string, string>>;
  readonly events: readonly { path: string; event: EventEnvelope }[];
}

/**
 * A legal continuation of `h`: 1–6 events on existing or new widgets, each legal by the reference
 * table on this branch alone. `side` sets the lowest bit of every random byte string's last byte,
 * so subject ids and event file names of the two sides never collide.
 */
function branch(g: fc.GeneratorValue, h: History, side: 0 | 1): Branch {
  const bytes = (n: number) => {
    const b = g(fc.uint8Array, { minLength: n, maxLength: n });
    b[n - 1] = ((b[n - 1] ?? 0) & 0xfe) | side;
    return (buf: Uint8Array) => buf.set(b);
  };
  const state = referenceFold(h.steps).subjects;
  const history = new Map<string, EventEnvelope[]>();
  for (const { subject, event } of h.steps)
    history.set(subject, [...(history.get(subject) ?? []), event]);
  const bodies = new Map(
    h.subjects.map((s) => [s.id, s.bodyPath === null ? "" : (h.files[s.bodyPath] ?? "")]),
  );
  const files: Record<string, string> = {};
  const events: { path: string; event: EventEnvelope }[] = [];
  let clock = Date.parse(h.steps.at(-1)?.event.at ?? "2001-01-01T00:00:00Z") / 1000;
  const count = g(fc.integer, { min: 1, max: 6 });
  for (let i = 0; i < count; i++) {
    clock += g(fc.integer, { min: 0, max: 3600 });
    let subject: string;
    let type: string;
    let body: { path: string; text: string } | null = null;
    if (state.size === 0 || g(fc.integer, { min: 0, max: 3 }) === 0) {
      subject = newSubjectId(bytes(5));
      if (bodies.has(subject)) continue;
      type = "created";
      const text = g(fc.string, { maxLength: 40 });
      body = { path: `${h.layout.root}/items/${bodyFileName(subject, "")}`, text };
    } else {
      subject = g(fc.constantFrom, ...state.keys());
      const status = state.get(subject)?.status ?? "draft";
      type = g(fc.constantFrom, ...Object.keys(NEXT[status]));
    }
    const { at, id } = nextEventIdentity(history.get(subject) ?? [], {
      now: () => clock * 1000,
      random: bytes(10),
    });
    const event: EventEnvelope = {
      envelope: "ledger/v1",
      kind: kind.name,
      schema: kind.schema,
      id,
      subject,
      type,
      at,
      actor: TEST_HUMAN,
      ...(type === "retired" ? { reason: "no longer needed" } : {}),
      data:
        type === "created"
          ? { title: "branch widget" }
          : type === "noted"
            ? { text: "note" }
            : type === "published"
              ? { body_sha256: hashOf(bodies.get(subject) ?? "") }
              : {},
    };
    const path = eventPath(h.layout, event);
    if (Object.hasOwn(files, path) || Object.hasOwn(h.files, path)) continue;
    const next = refStep(state.get(subject), event);
    if (next === null) throw new Error(`generated an illegal ${type}`);
    state.set(subject, next);
    history.set(subject, [...(history.get(subject) ?? []), event]);
    if (body !== null) {
      bodies.set(subject, body.text);
      files[body.path] = body.text;
    }
    files[path] = serializeEvent(event);
    events.push({ path, event });
  }
  return { files, events };
}

/**
 * Both sides from one generator: two `fc.gen()` arbitraries in one `fc.tuple` replay the same
 * random choices, so the sides would only ever make identical edits and never conflict otherwise.
 */
const merges = () =>
  histories({ maxSteps: 12 }).chain((h) =>
    fc.gen().map((g) => [h, branch(g, h, 0), branch(g, h, 1)] as const),
  );

/** The folded shape of every subject in `tree`, comparable with the reference model. */
async function ledgerFold(tree: TreeReader, h: History) {
  const log = foldLog(kind, await loadLog(tree, { kind: compiled, layout: h.layout }));
  return new Map(
    [...log.subjects].map(([id, s]) => [
      id,
      {
        status: s.status,
        state: s.state,
        applied: s.applied.map((a) => a.event.id),
        skipped: s.skipped.map((x) => x.path),
      },
    ]),
  );
}

/** What the reference model predicts for `ledgerFold`, and the illegal events. */
function expected(h: History, left: Branch, right: Branch) {
  const ref = referenceFold([...h.steps, ...left.events, ...right.events]);
  const skipped = new Set(ref.skipped);
  const all = [...h.steps, ...left.events, ...right.events];
  const fold = new Map(
    [...ref.subjects].map(([id, r]) => [
      id,
      {
        status: r.status,
        state: { title: r.title, notes: r.notes, revivals: r.revivals },
        applied: r.applied,
        skipped: all
          .filter((e) => e.event.subject === id && skipped.has(e.path))
          .map((e) => e.path)
          .sort(),
      },
    ]),
  );
  return { fold, skipped: ref.skipped };
}

/** Findings as sorted `<rule> <file>` lines, to compare with the reference model's skips. */
const lines = (fs: readonly Finding[]) => fs.map((f) => `${f.rule} ${f.file}`).sort();
const illegalLines = (paths: readonly string[]) => paths.map((p) => `transition/illegal ${p}`);

/** The git-backed properties spawn a few hundred git processes; allow for a loaded machine. */
const GIT_PROPERTY_TIMEOUT = 120_000;

describe("merge safety", () => {
  it("folds and verifies a merge of two legal branches like the reference model", async () => {
    await fc.assert(
      fc.asyncProperty(merges(), async ([h, left, right]) => {
        const merged = { ...h.files, ...left.files, ...right.files };
        expect(Object.keys(merged)).toHaveLength(
          Object.keys(h.files).length +
            Object.keys(left.files).length +
            Object.keys(right.files).length,
        );
        const want = expected(h, left, right);
        const got = await ledgerFold(new MemoryTree(merged), h);
        for (const s of got.values()) s.skipped.sort();
        expect(got).toEqual(want.fold);
        for (const [base, scope] of [
          [null, "all"],
          [new MemoryTree(h.files), "all"],
          [new MemoryTree(h.files), "changed"],
        ] as const) {
          const findings = await verifySnapshots({
            kind: compiled,
            layout: h.layout,
            base,
            head: new MemoryTree(merged),
            scope,
          });
          expect(findings.some((f) => f.severity === "error")).toBe(want.skipped.length > 0);
          expect(lines(findings)).toEqual(illegalLines(want.skipped));
        }
      }),
    );
  });

  it("finds illegal merges", () => {
    // The property above must see both outcomes, or it would pass vacuously.
    const samples = fc.sample(merges(), { numRuns: 200, seed: 11 });
    const outcomes = new Set(samples.map(([h, l, r]) => expected(h, l, r).skipped.length > 0));
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it(
    "holds for real merges and rebases with forkAndMerge",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          merges(),
          fc.constantFrom("merge" as const, "rebase" as const),
          async ([h, left, right], strategy) => {
            const r = await createTempRepo({ files: h.files });
            repos.push(r);
            const res = await forkAndMerge(r, {
              left: (t) => t.writeFiles(left.files),
              right: (t) => t.writeFiles(right.files),
              strategy,
            });
            const merged = { ...h.files, ...left.files, ...right.files };
            const want = expected(h, left, right);
            const got = await ledgerFold(await refReader(r.git, "HEAD"), h);
            for (const s of got.values()) s.skipped.sort();
            expect(got).toEqual(want.fold);
            expect(got).toEqual(await ledgerFold(new MemoryTree(merged), h));
            const findings = await verifyLog({
              git: r.git,
              kind,
              layout: h.layout,
              mode: { type: "range", base: res.base, head: "HEAD" },
            });
            expect(lines(findings)).toEqual(illegalLines(want.skipped));
          },
        ),
        { numRuns: 10 },
      );
    },
    GIT_PROPERTY_TIMEOUT,
  );
});

describe("time travel", () => {
  it(
    "folds each commit's tree like a MemoryTree of the files at that commit",
    async () => {
      await fc.assert(
        fc.asyncProperty(histories(), fc.gen(), async (h, g) => {
          const r = await createTempRepo();
          repos.push(r);
          const bodyOf = new Map(h.subjects.map((s) => [s.id, s.bodyPath]));
          const files: Record<string, string> = {};
          const commits: { sha: string; files: Record<string, string> }[] = [];
          let i = 0;
          while (i < h.steps.length) {
            const n = g(fc.integer, { min: 1, max: Math.max(1, h.steps.length - i) });
            const chunk: Record<string, string> = {};
            for (const { subject, path, event } of h.steps.slice(i, i + n)) {
              const body = bodyOf.get(subject) ?? null;
              if (event.type === "created" && body !== null) chunk[body] = h.files[body] ?? "";
              chunk[path] = h.files[path] ?? "";
            }
            i += n;
            await r.writeFiles(chunk);
            await r.stage(...Object.keys(chunk));
            Object.assign(files, chunk);
            commits.push({ sha: await r.commit(`steps to ${i}`), files: { ...files } });
          }
          expect(files).toEqual(h.files);
          for (const c of commits) {
            const fromGit = foldLog(
              kind,
              await loadLog(await refReader(r.git, c.sha), { kind: compiled, layout: h.layout }),
            );
            const fromMemory = foldLog(
              kind,
              await loadLog(new MemoryTree(c.files), { kind: compiled, layout: h.layout }),
            );
            expect(fromGit.subjects).toEqual(fromMemory.subjects);
          }
        }),
        { numRuns: 10 },
      );
    },
    GIT_PROPERTY_TIMEOUT,
  );
});
