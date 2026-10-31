import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { RefNotFoundError } from "../errors.js";
import { sortFindings } from "../findings/finding.js";
import { NO_INDEX_NUMBERING, NO_NUMBERING, type Numbering } from "../fold/numbering.js";
import { Git } from "../git/git.js";
import { MemoryTree } from "../git/tree.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind } from "../kind/define.js";
import type { KindFinding } from "../kind/types.js";
import type { LoadedEvent } from "../log/snapshot.js";
import { exampleMachineKind as widget } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  changedSince,
  eventsInFoldOrder,
  numberingJson,
  numberToolLog,
  readKindLog,
  unavailableReason,
} from "./log-read.js";

const run = promisify(execFile);
const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";

interface NoteOptions {
  /** Every folded note gets a `note/flagged` warning. */
  readonly flag: boolean;
  /** One `note/related` error on the log. */
  readonly relate: boolean;
}

/** Notes are drafted and accepted (numbered `N<n>`); their checks and projection read options. */
const note = defineKind({
  name: "note",
  schema: "note/v1",
  states: ["draft", "accepted"],
  events: {
    drafted: { data: { type: "object" }, allowedIn: [], to: "draft" },
    accepted: { data: { type: "object" }, allowedIn: ["draft"], to: "accepted" },
  },
  initial: "drafted",
  reduce: (n: number | null) => (n ?? 0) + 1,
  invariants: (s, o: NoteOptions): KindFinding[] =>
    o.flag
      ? [{ severity: "warning", rule: "note/flagged", message: "flagged", subject: s.id }]
      : [],
  relate: (log, o: NoteOptions): KindFinding[] =>
    o.relate
      ? [
          {
            severity: "error",
            rule: "note/related",
            message: "related",
            subject: [...log.subjects.keys()][0] ?? "",
          },
        ]
      : [],
  project: (s, ctx) => ({
    id: s.id,
    status: s.status,
    display: ctx.display(s.id),
    hasOptions: "options" in ctx,
    options: ctx.options,
  }),
  body: "mutable",
  layout: { bodies: "notes", events: "events" },
  defaultRoot: "log",
  numbering: { on: "accepted", format: (n) => `N${n}`, parse: () => null },
  options: { flag: false, relate: false } as NoteOptions,
});
const layout = note.layoutAt("log");

let seq = 0;
function ev(subject: string, type: string, at: string, kind = "note"): EventEnvelope {
  seq += 1;
  const id = createUlidFactory({ now: () => Date.parse(at), random: (b) => b.fill(seq) })();
  const schema = `${kind}/v1`;
  const base = { envelope: "ledger/v1", kind, schema, id, subject, type, at } as const;
  const data = type === "published" ? { body_sha256: "0".repeat(64) } : {};
  return { ...base, actor: TEST_HUMAN, data };
}

const files = (events: readonly EventEnvelope[], l = layout): Record<string, string> =>
  Object.fromEntries(events.map((e) => [eventPath(l, e), serializeEvent(e)]));

/** A drafted and accepted, B drafted, C accepted without a draft (a transition finding). */
const tree = () =>
  new MemoryTree({
    ...files([
      ev(A, "drafted", "2026-01-01T00:00:00Z"),
      ev(A, "accepted", "2026-01-02T00:00:00Z"),
      ev(B, "drafted", "2026-01-01T00:00:00Z"),
      ev(C, "drafted", "2026-01-01T00:00:00Z"),
      ev(C, "drafted", "2026-01-03T00:00:00Z"),
    ]),
    [`log/events/${B}/20260105T000000Z-0000-drafted.yaml`]: "not: [valid\n",
  });

const numbering = (byId: Record<string, number>): Numbering => ({
  available: true,
  reason: null,
  ref: "refs/heads/main",
  commit: null,
  byId: new Map(Object.entries(byId)),
  byNumber: new Map(Object.entries(byId).map(([id, n]) => [n, id])),
});

describe("readKindLog", () => {
  it("folds the log and numbers the projection with the given numbering", async () => {
    const r = await readKindLog(note, tree(), { layout, numbering: numbering({ [A]: 7, [B]: 8 }) });
    expect([...r.snapshot.subjects.keys()]).toEqual([A, B, C]);
    expect(r.folded.subjects.get(A)?.status).toBe("accepted");
    expect(r.folded.subjects.get(A)?.state).toBe(2);
    expect([...r.projection.views.values()].map((v) => [v.id, v.display])).toEqual([
      [A, "N7"],
      // B has no accepted event, so it isn't numbered.
      [B, B],
      [C, C],
    ]);
    const none = await readKindLog(note, tree(), { layout, numbering: NO_NUMBERING });
    expect(none.projection.views.get(A)?.display).toBe(A);
  });

  it("runs the load and transition checks, stamps the kind's name and sorts the findings", async () => {
    const r = await readKindLog(note, tree(), { layout, numbering: NO_NUMBERING });
    expect(r.findings.length).toBeGreaterThanOrEqual(2);
    expect(r.findings.map((f) => f.kind)).toEqual(r.findings.map(() => "note"));
    expect(r.findings).toEqual(sortFindings(r.findings));
    const rules = r.findings.map((f) => f.rule);
    expect(rules.some((x) => x.startsWith("transition/"))).toBe(true);
    expect(r.findings.some((f) => f.subject === B && !f.rule.startsWith("transition/"))).toBe(true);
    // The kind's default options add nothing.
    expect(rules.filter((x) => x.startsWith("note/"))).toEqual([]);
  });

  it("passes checkOptions to the invariants and relate checks", async () => {
    const flagged = await readKindLog(note, tree(), {
      layout,
      numbering: NO_NUMBERING,
      checkOptions: { flag: true, relate: false },
    });
    expect(flagged.findings.filter((f) => f.rule === "note/flagged").map((f) => f.subject)).toEqual(
      [A, B, C],
    );
    expect(flagged.findings.filter((f) => f.rule === "note/related")).toEqual([]);
    const related = await readKindLog(note, tree(), {
      layout,
      numbering: NO_NUMBERING,
      checkOptions: { flag: false, relate: true },
    });
    expect(related.findings.filter((f) => f.rule.startsWith("note/"))).toMatchObject([
      { rule: "note/related", subject: A, kind: "note", file: expect.stringContaining(A) },
    ]);
  });

  it("passes projectOptions to the projection only when given", async () => {
    const plain = await readKindLog(note, tree(), { layout, numbering: NO_NUMBERING });
    expect(plain.projection.views.get(A)).toMatchObject({ hasOptions: false, options: undefined });
    const given = await readKindLog(note, tree(), {
      layout,
      numbering: NO_NUMBERING,
      projectOptions: { sources: "x" },
    });
    expect(given.projection.views.get(A)).toMatchObject({
      hasOptions: true,
      options: { sources: "x" },
    });
  });

  it("lists unreadable and unfoldable subjects in the projection", async () => {
    const r = await readKindLog(
      note,
      new MemoryTree({ ...files([ev(A, "accepted", "2026-01-01T00:00:00Z")]) }),
      { layout, numbering: NO_NUMBERING },
    );
    expect(r.projection.views.size).toBe(0);
    expect(r.projection.unfoldable).toEqual([A]);
  });
});

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "repo\n" } });
  repos.push(r);
  return r;
}

const wlayout = widget.layoutAt("log");
/** A `published` event file of `subject`; the numbering reads only its path. */
const published = (subject: string, day: number) =>
  `log/events/${subject}/202601${String(day).padStart(2, "0")}T000000Z-0000-published.yaml`;
const indexText = (byId: Record<string, number>) =>
  `# Widgets\n\n<!-- ledger-index/v1 numbers:${Object.entries(byId)
    .map(([id, n]) => ` ${id}=${n}`)
    .join("")} -->\n`;

let clones = 0;
/** A `git clone --depth 1` of `r`, opened. */
async function shallowClone(r: TempRepo): Promise<Git> {
  const dest = join(r.root, "..", `shallow-${++clones}`);
  const env = { ...process.env, ...r.git.options.env } as Record<string, string>;
  await run("git", ["clone", "-q", "--depth", "1", `file://${r.root}`, dest], { env });
  return Git.open(dest, r.git.options);
}

describe("numberToolLog", () => {
  const number = (git: Git, o: { index: "none" | "committed"; ref?: string | null }) =>
    numberToolLog(git, {
      kind: widget,
      layout: wlayout,
      mainRef: null,
      index: o.index,
      ref: o.ref ?? null,
    });

  it("numbers from main's history, ignoring the index outside a shallow clone", async () => {
    const r = await repo();
    await r.writeFiles({
      [published(B, 1)]: "x\n",
      "log/index.md": indexText({ [A]: 1 }),
    });
    await r.stage(published(B, 1), "log/index.md");
    await r.commit("B");
    await r.write(published(A, 2), "x\n");
    await r.stage(published(A, 2));
    const head = await r.commit("A");
    const n = await number(r.git, { index: "committed" });
    expect(n).toMatchObject({
      available: true,
      reason: null,
      ref: "refs/heads/main",
      commit: head,
    });
    expect(Object.fromEntries(n.byId)).toEqual({ [B]: 1, [A]: 2 });
  });

  it("uses a configured main ref", async () => {
    const r = await repo();
    await r.write(published(B, 1), "x\n");
    await r.stage(published(B, 1));
    await r.commit("B");
    await r.checkout("release", { create: true });
    await r.write(published(A, 2), "x\n");
    await r.stage(published(A, 2));
    await r.commit("A");
    await r.checkout("main");
    const n = await numberToolLog(r.git, {
      kind: widget,
      layout: wlayout,
      mainRef: "release",
      index: "none",
      ref: null,
    });
    expect(n.ref).toBe("release");
    expect(Object.fromEntries(n.byId)).toEqual({ [B]: 1, [A]: 2 });
    await expect(
      numberToolLog(r.git, {
        kind: widget,
        layout: wlayout,
        mainRef: "nope",
        index: "none",
        ref: null,
      }),
    ).rejects.toBeInstanceOf(RefNotFoundError);
  });

  it("reads the committed index of the commit read in a shallow clone, only with index committed", async () => {
    const r = await repo();
    await r.writeFiles({ [published(A, 1)]: "x\n", "log/index.md": indexText({ [A]: 4 }) });
    await r.stage(published(A, 1), "log/index.md");
    await r.commit("A");
    const shallow = await shallowClone(r);
    // The work tree's copy may number acceptances that exist only there; it is never read.
    await writeFile(join(shallow.root as string, "log/index.md"), indexText({ [A]: 9, [B]: 10 }));
    const n = await number(shallow, { index: "committed" });
    expect(n).toMatchObject({ available: true, reason: "index", ref: null, commit: null });
    expect(Object.fromEntries(n.byId)).toEqual({ [A]: 4 });
    expect(Object.fromEntries(n.byNumber)).toEqual({ 4: A });
    expect(await number(shallow, { index: "committed", ref: "HEAD" })).toEqual(n);
    expect(await number(shallow, { index: "none" })).toEqual({
      ...NO_NUMBERING,
      reason: "shallow",
    });
  });

  it("is unavailable in a shallow clone when the ref doesn't resolve or has no index", async () => {
    const r = await repo();
    await r.write(published(A, 1), "x\n");
    await r.stage(published(A, 1));
    await r.commit("A");
    const unavailable = { ...NO_NUMBERING, reason: "shallow" };
    expect(await number(await shallowClone(r), { index: "committed" })).toEqual(unavailable);
    await r.write("log/index.md", indexText({ [A]: 1 }));
    await r.stage("log/index.md");
    await r.commit("index");
    const shallow = await shallowClone(r);
    expect((await number(shallow, { index: "committed" })).reason).toBe("index");
    expect(await number(shallow, { index: "committed", ref: "refs/heads/nope" })).toEqual(
      unavailable,
    );
  });
});

describe("changedSince", () => {
  it("lists the event files added since rev, in log order, from the ref's tree", async () => {
    const r = await repo();
    const first = ev(A, "created", "2026-01-01T00:00:00Z", "widget");
    await r.writeFiles(files([first], wlayout));
    await r.stage(eventPath(wlayout, first));
    const base = await r.commit("first");
    // B's event is older than A's, so it comes first although its path sorts last.
    const a = ev(A, "noted", "2026-01-05T00:00:00Z", "widget");
    const b = ev(B, "created", "2026-01-02T00:00:00Z", "widget");
    await r.writeFiles({
      ...files([a, b], wlayout),
      "log/items/aaaaaaaa-x.md": "body\n",
      [`log/events/${A}/nested/x.yaml`]: "x\n",
      [`log/events/${A}/not-an-event.txt`]: "x\n",
    });
    await r.stage("log");
    const head = await r.commit("second");
    const log = { git: r.git, layout: wlayout, ref: null };
    const since = await changedSince(log, base);
    expect(since).toEqual({
      rev: base,
      commit: base,
      events: [
        { subject: B, type: "created", path: eventPath(wlayout, b) },
        { subject: A, type: "noted", path: eventPath(wlayout, a) },
      ],
    });
    expect(await changedSince(log, "HEAD")).toEqual({ rev: "HEAD", commit: head, events: [] });
    expect(await changedSince({ ...log, ref: base }, base)).toMatchObject({ events: [] });
    await expect(changedSince(log, "nope")).rejects.toBeInstanceOf(RefNotFoundError);
  });
});

describe("unavailableReason", () => {
  it("says why numbers are unavailable", () => {
    expect(unavailableReason({ ...NO_NUMBERING, reason: "shallow" })).toBe("shallow clone");
    expect(unavailableReason(NO_INDEX_NUMBERING)).toBe("the log has no committed index.md");
    expect(unavailableReason(NO_INDEX_NUMBERING, "platform")).toBe(
      "platform has no committed index.md",
    );
    expect(unavailableReason(NO_NUMBERING)).toBe("no main branch");
    expect(unavailableReason(NO_NUMBERING, "platform")).toBe("no main branch");
  });
});

describe("numberingJson", () => {
  it("copies available, reason and ref, and nothing else", () => {
    expect(numberingJson({ numbering: numbering({ [A]: 1 }) })).toEqual({
      available: true,
      reason: null,
      ref: "refs/heads/main",
    });
    expect(numberingJson({ numbering: NO_INDEX_NUMBERING })).toEqual({
      available: false,
      reason: "no-index",
      ref: null,
    });
  });
});

describe("eventsInFoldOrder", () => {
  const loaded = (path: string, event: EventEnvelope | null): LoadedEvent => ({
    path,
    oid: null,
    bytes: new Uint8Array(),
    name: null,
    event,
    findings: [],
    versionKnown: true,
  });

  it("drops events that didn't parse and orders the rest by (at, id), then path", () => {
    const late = ev(A, "noted", "2026-01-03T00:00:00Z");
    const early = ev(A, "drafted", "2026-01-01T00:00:00Z");
    const sameAt = { ...ev(A, "noted", "2026-01-02T00:00:00Z"), id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" };
    const sameAtLowerId = { ...sameAt, id: "01AAAAAAAAAAAAAAAAAAAAAAAA", type: "accepted" };
    const duplicate = { ...sameAtLowerId, type: "duplicate" };
    const out = eventsInFoldOrder([
      loaded("log/events/a/4.yaml", late),
      loaded("log/events/a/3.yaml", sameAt),
      loaded("log/events/a/x.yaml", null),
      loaded("log/events/a/2b.yaml", duplicate),
      loaded("log/events/a/2a.yaml", sameAtLowerId),
      loaded("log/events/a/1.yaml", early),
    ]);
    expect(out).toEqual([early, sameAtLowerId, duplicate, sameAt, late]);
    expect(eventsInFoldOrder([])).toEqual([]);
  });
});
