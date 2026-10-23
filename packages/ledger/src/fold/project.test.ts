import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind } from "../kind/define.js";
import { loadLog } from "../log/snapshot.js";
import { exampleMachineKind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { foldLog } from "./fold.js";
import { NO_NUMBERING, type Numbering } from "./numbering.js";
import { kindFindings, projectLog } from "./project.js";

/** Notes are drafted and then accepted, which numbers them `N<n>`. Bodies stay mutable. */
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
  project: (s, ctx) => ({
    status: s.status,
    events: s.state,
    number: ctx.number(s.id),
    display: ctx.display(s.id),
    hash: ctx.bodySha256(s.id),
    subjects: ctx.log.subjects.size,
  }),
  body: "mutable",
  layout: { bodies: "notes", events: "events" },
  defaultRoot: "log",
  numbering: { on: "accepted", format: (n) => `N${n}`, parse: () => null },
  options: undefined,
});
const layout = note.layoutAt("log");

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const D = "dddddddd";

let seq = 0;
function ev(subject: string, type: string, at: string, schema = "note/v1"): EventEnvelope {
  seq += 1;
  const id = createUlidFactory({ now: () => Date.parse(at), random: (b) => b.fill(seq) })();
  const base = { envelope: "ledger/v1", kind: "note", schema, id, subject, type, at } as const;
  return { ...base, actor: TEST_HUMAN, data: {} };
}

const events = {
  aDrafted: ev(A, "drafted", "2026-01-01T00:00:00Z"),
  aAccepted: ev(A, "accepted", "2026-01-02T00:00:00Z"),
  bDrafted: ev(B, "drafted", "2026-01-01T00:00:00Z"),
  cAccepted: ev(C, "accepted", "2026-01-01T00:00:00Z"),
  dFuture: ev(D, "drafted", "2026-01-01T00:00:00Z", "note/v2"),
};
const files: Record<string, string> = {
  [`log/notes/${A}-first.md`]: "a\n",
  [`log/notes/${C}.md`]: "c\n",
  ...Object.fromEntries(
    Object.values(events).map((e) => [eventPath(layout, e), serializeEvent(e)]),
  ),
};

const numbering = (byId: Record<string, number>): Numbering => ({
  available: true,
  reason: null,
  ref: "refs/heads/main",
  commit: null,
  byId: new Map(Object.entries(byId)),
  byNumber: new Map(Object.entries(byId).map(([id, n]) => [n, id])),
});

async function folded() {
  const snap = await loadLog(new MemoryTree(files), { kind: compileKind(note), layout });
  return foldLog(note, snap);
}

describe("projectLog", () => {
  it("projects folded subjects and lists the others", async () => {
    const p = projectLog(note, await folded(), { numbering: numbering({ [A]: 1, [B]: 2 }) });
    expect([...p.views.keys()]).toEqual([A, B]);
    expect(p.views.get(A)).toEqual({
      status: "accepted",
      events: 2,
      number: 1,
      display: "N1",
      hash: bodySha256(new TextEncoder().encode("a\n")),
      subjects: 4,
    });
    expect(p.unreadable).toEqual([D]);
    expect(p.unfoldable).toEqual([C]);
  });

  it("shows a number only for subjects with an applied numbering event", async () => {
    const p = projectLog(note, await folded(), { numbering: numbering({ [A]: 1, [B]: 2 }) });
    expect(p.views.get(B)).toMatchObject({ number: null, display: B, hash: null });
  });

  it("shows ids without numbering", async () => {
    const p = projectLog(note, await folded(), { numbering: NO_NUMBERING });
    expect(p.views.get(A)).toMatchObject({ number: null, display: A });
  });

  it("works with the widget kind's projection", async () => {
    const snap = await loadLog(new MemoryTree({}), {
      kind: compileKind(exampleMachineKind),
      layout: exampleMachineKind.layoutAt("log"),
    });
    const p = projectLog(exampleMachineKind, foldLog(exampleMachineKind, snap), {
      numbering: NO_NUMBERING,
    });
    expect(p).toEqual({ views: new Map(), unreadable: [], unfoldable: [] });
  });
});

describe("kindFindings", () => {
  it("maps each finding to its event file, else the body, else the event directory", async () => {
    const log = await folded();
    const found = kindFindings(log, [
      {
        severity: "error",
        rule: "note/a",
        message: "on an event",
        subject: A,
        event: events.aAccepted.id,
      },
      { severity: "warning", rule: "note/b", message: "unknown event", subject: A, event: "x" },
      { severity: "error", rule: "note/c", message: "no body", subject: B, related: [A] },
      { severity: "error", rule: "note/d", message: "not loaded", subject: "eeeeeeee" },
    ]);
    expect(found).toEqual([
      {
        severity: "error",
        rule: "note/a",
        message: "on an event",
        file: eventPath(layout, events.aAccepted),
        line: null,
        subject: A,
        kind: "note",
      },
      expect.objectContaining({ severity: "warning", file: `log/notes/${A}-first.md` }),
      expect.objectContaining({ file: `log/events/${B}` }),
      expect.objectContaining({ file: "log/events/eeeeeeee", subject: "eeeeeeee" }),
    ]);
  });
});
