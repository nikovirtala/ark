import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { InvalidArgumentError } from "../errors.js";
import { foldLog } from "../fold/fold.js";
import { MemoryTree } from "../git/tree.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind } from "../kind/define.js";
import type { AnyKind } from "../kind/types.js";
import { loadLog } from "../log/snapshot.js";
import { exampleMachineKind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { scopedSubjects, scopeLookup } from "./lookup.js";
import { setEventType } from "./set.js";

const A = "a7c2m9xd";
const B = "b3k8q1zz";
const C = "c9d4e5f6";

describe("scopeLookup", () => {
  const lookup = scopeLookup({
    subjects: [
      { id: B, globs: ["src/**", "src/*.ts", "lib/**"] },
      { id: A, globs: ["src/a.ts"] },
      { id: C, globs: [] },
    ],
    anchors: [
      { path: "src/a.ts", line: 9, source: null, id: A },
      { path: "src/a.ts", line: 3, source: null, id: A },
      { path: "src/a.ts", line: 4, source: "team", id: C },
      { path: "src/a.ts", line: 2, source: "alpha", id: C },
      { path: "src/a.ts", line: 5, source: null, id: C },
      { path: "lib/x.ts", line: 1, source: null, id: A },
    ],
  });

  it("returns each subject once with its globs, then its anchor lines", () => {
    expect(lookup("src/a.ts")).toEqual([
      {
        source: null,
        id: A,
        via: [
          { type: "glob", glob: "src/a.ts" },
          { type: "anchor", line: 3 },
          { type: "anchor", line: 9 },
        ],
      },
      {
        source: null,
        id: B,
        via: [
          { type: "glob", glob: "src/**" },
          { type: "glob", glob: "src/*.ts" },
        ],
      },
      { source: null, id: C, via: [{ type: "anchor", line: 5 }] },
      { source: "alpha", id: C, via: [{ type: "anchor", line: 2 }] },
      { source: "team", id: C, via: [{ type: "anchor", line: 4 }] },
    ]);
  });

  it("matches other paths by glob or anchor only", () => {
    expect(lookup("lib/x.ts")).toEqual([
      { source: null, id: A, via: [{ type: "anchor", line: 1 }] },
      { source: null, id: B, via: [{ type: "glob", glob: "lib/**" }] },
    ]);
    expect(lookup("README.md")).toEqual([]);
  });
});

const base = exampleMachineKind.def;
const labeledKind = defineKind({
  name: base.name,
  schema: base.schema,
  states: base.states,
  initial: base.initial,
  body: "mutable",
  layout: base.layout,
  defaultRoot: base.defaultRoot,
  options: base.options,
  events: {
    ...base.events,
    labeled: setEventType({ item: { type: "string" }, maxItems: 10, allowedIn: ["draft"] }),
  },
  reduce: (state: null, _e) => state,
  project: (s) => s.id,
  scope: { event: "labeled", activeIn: ["draft"] },
});

describe("scopedSubjects", () => {
  const layout = labeledKind.layoutAt("log");
  let ms = Date.parse("2026-01-01T00:00:00Z");
  const ev = (subject: string, type: string, data: Record<string, unknown>): EventEnvelope => {
    ms += 1000;
    const id = createUlidFactory({ now: () => ms })();
    return {
      envelope: "ledger/v1",
      kind: "widget",
      schema: "widget/v1",
      id,
      subject,
      type,
      at: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
      actor: TEST_HUMAN,
      data,
    };
  };
  const events = [
    ev(B, "created", { title: "B" }),
    ev(A, "created", { title: "A" }),
    ev(A, "labeled", { set: ["src/**"] }),
    ev(A, "labeled", { set: ["lib/**", "src/**"] }),
    ev(B, "published", { body_sha256: "0".repeat(64) }),
    ev(B, "labeled", { set: ["skipped/**"] }),
    ev(C, "labeled", { set: ["never/**"] }),
  ];
  const files = Object.fromEntries(events.map((e) => [eventPath(layout, e), serializeEvent(e)]));

  async function fold<K extends AnyKind>(kind: K) {
    const snap = await loadLog(new MemoryTree(files), { kind: compileKind(kind), layout });
    return foldLog(kind, snap);
  }

  it("lists folded subjects with their latest applied set", async () => {
    expect(scopedSubjects(await fold(labeledKind))).toEqual([
      { id: A, status: "draft", globs: ["lib/**", "src/**"] },
      { id: B, status: "published", globs: [] },
    ]);
  });

  it("refuses a kind without scope", async () => {
    const log = await fold(exampleMachineKind);
    expect(() => scopedSubjects(log)).toThrow(InvalidArgumentError);
    expect(() => scopedSubjects(log)).toThrow("kind widget has no scope event");
  });
});
