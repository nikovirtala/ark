import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { InvalidArgumentError } from "../errors.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind } from "../kind/define.js";
import { loadLog } from "../log/snapshot.js";
import { exampleKind, exampleLayout } from "../testing/example-kind.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { compareEvents, foldLog, foldSubject, sortInLogOrder } from "./fold.js";

const layout = kind.layoutAt("log");
const S = "a7c2m9xd";
const BODY = "# Widget\n";
const BODY_PATH = `log/items/${S}.md`;
const HASH = bodySha256(new TextEncoder().encode(BODY));

/** An event at `at` whose ULID time is `at` + `ms` and whose random part is all `rand` bytes. */
function ev(
  type: string,
  at: string,
  o: { data?: Record<string, unknown>; ms?: number; rand?: number; reason?: string } = {},
): EventEnvelope {
  const id = createUlidFactory({
    now: () => Date.parse(at) + (o.ms ?? 0),
    random: (b) => b.fill(o.rand ?? 1),
  })();
  const data =
    o.data ??
    (type === "created"
      ? { title: "Gear" }
      : type === "published"
        ? { body_sha256: HASH }
        : type === "noted"
          ? { text: "note" }
          : {});
  return {
    envelope: "ledger/v1",
    kind: "widget",
    schema: "widget/v1",
    id,
    subject: S,
    type,
    at,
    actor: TEST_HUMAN,
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    data,
  };
}

const filesOf = (events: readonly EventEnvelope[], body: string | null = BODY) => ({
  ...(body === null ? {} : { [BODY_PATH]: body }),
  ...Object.fromEntries(events.map((e) => [eventPath(layout, e), serializeEvent(e)])),
});

async function fold(files: Record<string, string>) {
  const snap = await loadLog(new MemoryTree(files), { kind: compileKind(kind), layout });
  return foldLog(kind, snap);
}

async function foldOne(files: Record<string, string>) {
  const s = (await fold(files)).subjects.get(S);
  if (s === undefined) throw new Error(`subject ${S} not loaded`);
  return s;
}

describe("compareEvents", () => {
  it("orders by at, then id, then path", () => {
    const a = { at: "2026-01-01T00:00:00Z", id: "01J0000000000000000000000B" };
    expect(
      compareEvents(a, { ...a, at: "2026-01-01T00:00:01Z", id: "01J0000000000000000000000A" }),
    ).toBe(-1);
    expect(compareEvents(a, { ...a, id: "01J0000000000000000000000A" })).toBe(1);
    expect(compareEvents({ ...a, path: "b" }, { ...a, path: "a" })).toBe(1);
    expect(compareEvents({ ...a, path: "a" }, { ...a, path: "a" })).toBe(0);
    expect(compareEvents(a, a)).toBe(0);
  });
});

describe("sortInLogOrder", () => {
  const T = "2026-03-14T12:00:00Z";

  it("orders events of one second by id, whatever their paths say", async () => {
    // Same `at`, ids one millisecond apart: the fold applies `created` first. Find random parts
    // that make `noted`'s path sort first, as two writes in one second can.
    let pair: [EventEnvelope, EventEnvelope] | null = null;
    for (let r = 0; r < 256 && pair === null; r++) {
      const first = ev("created", T, { rand: r });
      const second = ev("noted", T, { ms: 1, rand: 255 - r });
      if (eventPath(layout, second) < eventPath(layout, first)) pair = [first, second];
    }
    if (pair === null) throw new Error("no random parts put the later event's path first");
    const [first, second] = pair;
    const tree = new MemoryTree(filesOf([first, second]));
    const listed = [first, second]
      .map((e) => ({ path: eventPath(layout, e), type: e.type }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(listed.map((e) => e.type)).toEqual(["noted", "created"]);
    const sorted = await sortInLogOrder(tree, listed);
    expect(sorted.map((e) => e.type)).toEqual(["created", "noted"]);
  });

  it("sorts files that are missing or don't parse first, by path", async () => {
    const e = ev("created", T);
    const tree = new MemoryTree({ ...filesOf([e]), "log/events/x/bad.yaml": "{" });
    const sorted = await sortInLogOrder(tree, [
      { path: eventPath(layout, e) },
      { path: "log/events/x/missing.yaml" },
      { path: "log/events/x/bad.yaml" },
    ]);
    expect(sorted.map((s) => s.path)).toEqual([
      "log/events/x/bad.yaml",
      "log/events/x/missing.yaml",
      eventPath(layout, e),
    ]);
  });
});

describe("foldSubject", () => {
  const T = "2026-03-14T12:00:00Z";
  const T1 = "2026-03-14T12:00:01Z";
  const T2 = "2026-03-14T12:00:02Z";
  const T3 = "2026-03-14T12:00:03Z";

  it("replays a legal history through the machine and the reducer", async () => {
    const events = [
      ev("created", T),
      ev("noted", T1),
      ev("published", T2),
      ev("retired", T3, { reason: "old" }),
    ];
    const s = await foldOne(filesOf(events));
    expect(s.status).toBe("retired");
    expect(s.state).toEqual({ title: "Gear", notes: 1, revivals: 0 });
    expect(s.applied.map((a) => [a.event.type, a.from, a.to])).toEqual([
      ["created", null, "draft"],
      ["noted", "draft", "draft"],
      ["published", "draft", "published"],
      ["retired", "published", "retired"],
    ]);
    expect(s.applied.map((a) => a.path)).toEqual(events.map((e) => eventPath(layout, e)));
    expect(s.skipped).toEqual([]);
    expect(s.findings).toEqual([]);
  });

  it("orders same-second events by id, not by file name", async () => {
    // Same stamp: the file names sort by rand, so `published` (rand 0000) comes first on disk.
    const created = ev("created", T, { rand: 255 });
    const published = ev("published", T, { ms: 1, rand: 0 });
    expect(eventPath(layout, published) < eventPath(layout, created)).toBe(true);
    const s = await foldOne(filesOf([created, published]));
    expect(s.applied.map((a) => a.event.type)).toEqual(["created", "published"]);
    expect(s.status).toBe("published");
    expect(s.findings).toEqual([]);
  });

  it("reports a first event that isn't initial and skips every event", async () => {
    const noted = ev("noted", T);
    const events = [noted, ev("created", T1), ev("published", T2)];
    const s = await foldOne(filesOf(events));
    expect(s.status).toBeNull();
    expect(s.state).toBeNull();
    expect(s.applied).toEqual([]);
    expect(s.skipped.map((x) => [x.event.type, x.rule])).toEqual([
      ["noted", "transition/not-initial"],
      ["created", "transition/not-initial"],
      ["published", "transition/not-initial"],
    ]);
    expect(s.findings).toEqual([
      expect.objectContaining({
        rule: "transition/not-initial",
        message: "first event is noted; it must be created",
        file: eventPath(layout, noted),
        subject: S,
      }),
    ]);
  });

  it("skips an illegal event without changing status or state", async () => {
    const again = ev("published", T2);
    const events = [ev("created", T), ev("published", T1), again, ev("noted", T3)];
    const s = await foldOne(filesOf(events));
    expect(s.status).toBe("published");
    expect(s.state).toEqual({ title: "Gear", notes: 1, revivals: 0 });
    expect(s.applied.map((a) => a.event.type)).toEqual(["created", "published", "noted"]);
    expect(s.skipped).toEqual([
      { path: eventPath(layout, again), event: again, rule: "transition/illegal" },
    ]);
    expect(s.findings).toEqual([
      expect.objectContaining({
        severity: "error",
        rule: "transition/illegal",
        message: "published is not allowed while published",
        file: eventPath(layout, again),
        subject: S,
      }),
    ]);
  });

  it("treats a second initial event as illegal", async () => {
    const s = await foldOne(
      filesOf([ev("created", T), ev("created", T1, { data: { title: "B" } })]),
    );
    expect(s.state).toEqual({ title: "Gear", notes: 0, revivals: 0 });
    expect(s.findings.map((f) => f.message)).toEqual(["created is not allowed while draft"]);
  });

  it("says when the status is terminal", async () => {
    const task = defineKind({
      name: "task",
      schema: "task/v1",
      states: ["open", "done"],
      events: {
        opened: { data: { type: "object" }, allowedIn: [], to: "open" },
        finished: { data: { type: "object" }, allowedIn: ["open"], to: "done" },
      },
      initial: "opened",
      reduce: () => null,
      project: (s) => s.id,
      body: "none",
      layout: { bodies: null, events: "events" },
      defaultRoot: "tasks",
      options: undefined,
    });
    const taskLayout = task.layoutAt("tasks");
    const events = [ev("opened", T), ev("finished", T1), ev("finished", T2)].map((e) => ({
      ...e,
      kind: "task",
      schema: "task/v1",
      data: {},
    }));
    const files = Object.fromEntries(
      events.map((e) => [eventPath(taskLayout, e), serializeEvent(e)]),
    );
    const snap = await loadLog(new MemoryTree(files), {
      kind: compileKind(task),
      layout: taskLayout,
    });
    const s = foldLog(task, snap).subjects.get(S);
    expect(s?.status).toBe("done");
    expect(s?.findings.map((f) => f.message)).toEqual([
      "finished is not allowed while done; done is terminal",
    ]);
  });

  it("doesn't fold an unreadable subject and adds no findings", async () => {
    const future = { ...ev("noted", T1), schema: "widget/v9" };
    const s = await foldOne(filesOf([ev("created", T), future]));
    expect(s.loaded.readable).toBe(false);
    expect(s).toMatchObject({ status: null, state: null, applied: [], skipped: [], findings: [] });
  });

  it("reports a body without events", async () => {
    const s = await foldOne(filesOf([]));
    expect(s.status).toBeNull();
    expect(s.findings).toEqual([
      expect.objectContaining({
        rule: "transition/no-events",
        message: "body file has no events; its first event must be created",
        file: BODY_PATH,
        subject: S,
      }),
    ]);
  });

  it("leaves a body whose only events are invalid to the load findings", async () => {
    const files = { ...filesOf([]), [`log/events/${S}/20260314T120000Z-0000-created.yaml`]: "[" };
    const s = await foldOne(files);
    expect(s.status).toBeNull();
    expect(s.loaded.events[0]?.findings.length).toBeGreaterThan(0);
    expect(s.findings).toEqual([]);
  });

  it("folds only valid events", async () => {
    const files = {
      ...filesOf([ev("created", T)]),
      [`log/events/${S}/20260314T120001Z-0000-noted.yaml`]: "not: [valid",
    };
    const s = await foldOne(files);
    expect(s.status).toBe("draft");
    expect(s.applied).toHaveLength(1);
  });
});

describe("foldLog", () => {
  it("folds every subject, sorted by id", async () => {
    const other = { ...ev("created", "2026-01-01T00:00:00Z"), subject: "0000aaaa" };
    const log = await fold({
      ...filesOf([ev("created", "2026-01-01T00:00:00Z")]),
      ...filesOf([other], null),
    });
    expect([...log.subjects.keys()]).toEqual(["0000aaaa", S]);
    expect(log.kind).toBe(kind);
    expect([...log.subjects.values()].map((s) => s.status)).toEqual(["draft", "draft"]);
  });

  it("throws for a snapshot loaded with another kind", async () => {
    const snap = await loadLog(new MemoryTree({}), {
      kind: compileKind(exampleKind),
      layout: exampleLayout,
    });
    expect(() => foldLog(kind, snap)).toThrow(InvalidArgumentError);
  });

  it("exposes foldSubject for single subjects", async () => {
    const snap = await loadLog(new MemoryTree(filesOf([ev("created", "2026-01-01T00:00:00Z")])), {
      kind: compileKind(kind),
      layout,
    });
    const loaded = snap.subjects.get(S);
    if (loaded === undefined) throw new Error("not loaded");
    expect(foldSubject(kind, loaded).status).toBe("draft");
  });
});
