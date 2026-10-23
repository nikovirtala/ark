import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { UsageError } from "../errors.js";
import { foldLog } from "../fold/fold.js";
import { MemoryTree } from "../git/tree.js";
import { bodySha256 } from "../identity/hash.js";
import { eventPath } from "../identity/layout.js";
import { formatAt } from "../identity/time.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind } from "../kind/define.js";
import { loadLog } from "../log/snapshot.js";
import { exampleMachineKind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { applySetOp, latestSet, setEventType } from "./set.js";

const ADR_NAMES = { set: "--set", add: "--add", remove: "--remove", clear: "--clear" };

describe("setEventType", () => {
  it("declares a whole-set data schema that never changes state", () => {
    expect(
      setEventType({
        item: { type: "string", minLength: 1, maxLength: 500 },
        maxItems: 200,
        allowedIn: ["proposed", "accepted", "deprecated"],
      }),
    ).toEqual({
      data: {
        type: "object",
        required: ["set"],
        properties: {
          set: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 500 },
            uniqueItems: true,
            maxItems: 200,
          },
        },
      },
      allowedIn: ["proposed", "accepted", "deprecated"],
      to: null,
    });
  });
});

describe("applySetOp", () => {
  const usage = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      return (e as Error).message;
    }
    throw new Error("expected a UsageError");
  };

  it("refuses no operation at all (rule 1)", () => {
    expect(usage(() => applySetOp(["a"], {}))).toBe("nothing to change: give set, add or remove");
    expect(usage(() => applySetOp(["a"], { add: [], remove: [] }))).toBe(
      "nothing to change: give set, add or remove",
    );
    expect(usage(() => applySetOp(["a"], {}, { names: ADR_NAMES }))).toBe(
      "nothing to change: give --set, --add, --remove or --clear",
    );
    expect(
      usage(() => applySetOp([], {}, { names: { set: "--set", add: "--add", remove: "--rm" } })),
    ).toBe("nothing to change: give --set, --add or --rm");
  });

  it("refuses set with add or remove (rule 2)", () => {
    expect(usage(() => applySetOp([], { set: ["a"], add: ["b"] }))).toBe(
      "set can't be combined with add or remove",
    );
    expect(usage(() => applySetOp([], { set: [], remove: ["b"] }, { names: ADR_NAMES }))).toBe(
      "--set can't be combined with --add or --remove",
    );
    expect(applySetOp(["a"], { set: ["b"], add: [], remove: [] }).set).toEqual(["b"]);
  });

  it("refuses an item both added and removed (rule 3)", () => {
    expect(usage(() => applySetOp([], { add: ["a", "b"], remove: ["b"] }, { what: "glob" }))).toBe(
      "glob b is both added and removed",
    );
  });

  it("validates set and add items, never remove items (rule 4)", () => {
    const validate = (x: string) => (x.startsWith("!") ? `bad ${x}` : null);
    expect(usage(() => applySetOp([], { add: ["a", "!b"] }, { validate }))).toBe("bad !b");
    expect(usage(() => applySetOp([], { set: ["!c"] }, { validate }))).toBe("bad !c");
    const r = applySetOp(["!hand", "a"], { remove: ["!hand"] }, { validate });
    expect(r).toMatchObject({ set: ["a"], removed: ["!hand"], changed: true });
  });

  it("sorts and deduplicates the result (rule 5)", () => {
    expect(applySetOp(["c", "a"], { add: ["b", "b", "a"], remove: ["c", "z"] })).toEqual({
      set: ["a", "b"],
      changed: true,
      added: ["b"],
      removed: ["c"],
      absent: ["z"],
      present: ["a"],
    });
    expect(applySetOp(["b", "a", "a"], { set: ["a", "b", "a"] })).toEqual({
      set: ["a", "b"],
      changed: false,
      added: [],
      removed: [],
      absent: [],
      present: [],
    });
  });

  it("clears with an empty set", () => {
    expect(applySetOp(["a", "b"], { set: [] })).toMatchObject({
      set: [],
      changed: true,
      removed: ["a", "b"],
    });
    expect(applySetOp([], { set: [] }).changed).toBe(false);
    expect(applySetOp(["a"], { remove: ["a"] }).set).toEqual([]);
  });

  it("refuses a result over maxItems (rule 6)", () => {
    expect(usage(() => applySetOp(["a", "b"], { add: ["c"] }, { maxItems: 2, what: "glob" }))).toBe(
      "3 globs; the limit is 2",
    );
    expect(usage(() => applySetOp([], { set: ["a", "b"] }, { maxItems: 1 }))).toBe(
      "2 items; the limit is 1",
    );
    expect(applySetOp(["a", "b", "c"], { remove: ["c"] }, { maxItems: 2 }).set).toEqual(["a", "b"]);
  });

  it("computes (current − remove) ∪ add, or set, and is idempotent", () => {
    const item: fc.Arbitrary<string> = fc.constantFrom("a", "b", "c", "d", "e", "B");
    const items = fc.array(item, { maxLength: 6 });
    const op = fc.oneof(
      items.map((set) => ({ set })),
      fc
        .record({ add: items, remove: items })
        .map(({ add, remove }) => ({ add, remove: remove.filter((x) => !add.includes(x)) }))
        .filter(({ add, remove }) => add.length > 0 || remove.length > 0),
    );
    const canon = (xs: readonly string[]) => [...new Set(xs)].sort();
    fc.assert(
      fc.property(items, op, (current, o) => {
        const r = applySetOp(current, o);
        const expected =
          "set" in o
            ? canon(o.set)
            : canon([...current.filter((x) => !o.remove.includes(x)), ...o.add]);
        expect(r.set).toEqual(expected);
        expect(applySetOp(r.set, o).set).toEqual(r.set);
        expect(applySetOp(r.set, o).changed).toBe(false);
        expect(r.changed).toBe(JSON.stringify(expected) !== JSON.stringify(canon(current)));
        expect(r.added).toEqual(expected.filter((x) => !current.includes(x)));
        expect(r.removed).toEqual(canon(current).filter((x) => !expected.includes(x)));
        if ("add" in o) {
          expect(r.absent).toEqual(canon(o.remove.filter((x) => !current.includes(x))));
          expect(r.present).toEqual(canon(o.add.filter((x) => current.includes(x))));
        }
      }),
    );
  });
});

// exampleMachineKind with a whole-set `labeled` event, allowed while draft or published.
const base = exampleMachineKind.def;
const labeledKind = defineKind({
  name: base.name,
  schema: base.schema,
  states: base.states,
  initial: base.initial,
  body: base.body,
  layout: base.layout,
  defaultRoot: base.defaultRoot,
  options: base.options,
  events: {
    ...exampleMachineKind.def.events,
    labeled: setEventType({
      item: { type: "string", minLength: 1 },
      maxItems: 10,
      allowedIn: ["draft", "published"],
    }),
  },
  reduce: (state: { readonly labels: readonly string[] } | null, e) =>
    e.type === "labeled" ? { labels: e.data.set } : (state ?? { labels: [] }),
  project: (s) => s.state,
  scope: { event: "labeled", activeIn: ["draft", "published"] },
});

describe("set events", () => {
  const S = "a7c2m9xd";
  const layout = labeledKind.layoutAt("log");
  const BODY = "# Widget\n";
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const TRANSITIONS: Record<string, { from: readonly string[] | "any"; to: string | null }> = {
    labeled: { from: ["draft", "published"], to: null },
    published: { from: ["draft"], to: "published" },
    retired: { from: ["published"], to: "retired" },
    revived: { from: ["retired"], to: "published" },
  };

  function event(
    type: string,
    ms: number,
    rand: Uint8Array,
    data: Record<string, unknown>,
  ): EventEnvelope {
    const id = createUlidFactory({ now: () => ms, random: (b) => b.set(rand) })();
    return {
      envelope: "ledger/v1",
      kind: "widget",
      schema: "widget/v1",
      id,
      subject: S,
      type,
      at: formatAt(new Date(ms)),
      actor: TEST_HUMAN,
      ...(type === "retired" ? { reason: "old" } : {}),
      data,
    };
  }

  const arbStep = fc.record({
    type: fc.constantFrom("labeled", "labeled", "labeled", "published", "retired", "revived"),
    second: fc.integer({ min: 1, max: 4 }),
    rand: fc.uint8Array({ minLength: 10, maxLength: 10 }),
    set: fc.uniqueArray(fc.constantFrom("a", "b", "c", "d"), { maxLength: 4 }),
  });

  it("keeps the latest applied set in fold order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(arbStep, { minLength: 1, maxLength: 12 })
          .filter((steps) => steps.filter((s) => s.type === "labeled").length <= 8),
        fc.infiniteStream(fc.double({ min: 0, max: 1, noNaN: true })),
        async (steps, keys) => {
          const hash = bodySha256(new TextEncoder().encode(BODY));
          const events = [
            event("created", T0, new Uint8Array(10), { title: "Gear" }),
            ...steps.map((s) =>
              event(
                s.type,
                T0 + s.second * 1000,
                s.rand,
                s.type === "labeled"
                  ? { set: s.set }
                  : s.type === "published"
                    ? { body_sha256: hash }
                    : {},
              ),
            ),
          ];
          const files = events.map((e) => [eventPath(layout, e), serializeEvent(e)] as const);
          const order = [...files.keys()].map((i) => [keys.next().value as number, i] as const);
          order.sort((a, b) => a[0] - b[0]);
          const shuffled = Object.fromEntries([
            [`log/items/${S}.md`, BODY],
            ...order.map(([, i]) => files[i] as readonly [string, string]),
          ]);
          const snap = await loadLog(new MemoryTree(shuffled), {
            kind: compileKind(labeledKind),
            layout,
          });
          const subject = foldLog(labeledKind, snap).subjects.get(S);
          if (subject === undefined) throw new Error("subject not folded");

          // Reference: replay in (at, id) order through the transitions written out above.
          const sorted = events
            .slice(1)
            .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
          let status = "draft";
          let expected: readonly string[] | null = null;
          for (const e of sorted) {
            const t = TRANSITIONS[e.type];
            if (t === undefined || (t.from !== "any" && !t.from.includes(status))) continue;
            if (t.to !== null) status = t.to;
            if (e.type === "labeled") expected = (e.data as { set: string[] }).set;
          }
          expect(subject.status).toBe(status);
          expect(latestSet(subject, "labeled")).toEqual(expected);
          expect(subject.state?.labels).toEqual(expected ?? []);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null without a set event", () => {
    const subject = {
      id: S,
      status: "draft",
      state: null,
      applied: [],
      skipped: [],
      findings: [],
      loaded: { id: S, events: [], bodyPaths: [], body: null, findings: [], readable: true },
    };
    expect(latestSet(subject, "labeled")).toBeNull();
  });
});
