import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import { InvalidArgumentError } from "../errors.js";
import { foldLog } from "../fold/fold.js";
import { MemoryTree } from "../git/tree.js";
import { defineKind, eventType } from "../kind/define.js";
import { loadLog } from "../log/snapshot.js";
import { verifySnapshots } from "../verify/verify.js";
import { exampleMachineKind as widget } from "./example-machine-kind.js";
import { arbLegalHistory, type DataArbs } from "./history.js";
import { applySemanticTamper, arbSemanticTamper, type SemanticTamper } from "./semantic-tamper.js";
import { body, histories, scopes, verify, widgetData } from "./semantic-tamper-support.js";

describe("semantic tampers", () => {
  for (const scope of scopes) {
    it(`leave an untampered history without findings (scope ${scope})`, async () => {
      await fc.assert(
        fc.asyncProperty(histories(), async (h) => {
          const base = scope === "all" ? null : new MemoryTree({});
          const findings = await verifySnapshots({
            kind: compileKind(widget),
            layout: h.layout,
            base,
            head: new MemoryTree(h.files),
            scope,
          });
          expect(findings).toEqual([]);
        }),
      );
    });
  }

  it("prefer subjects in a terminal state for illegal transitions", async () => {
    const task = defineKind({
      name: "task",
      schema: "task/v1",
      states: ["open", "done"],
      events: {
        opened: eventType()({ data: { type: "object" }, allowedIn: [], to: "open" }),
        done: eventType()({ data: { type: "object" }, allowedIn: ["open"], to: "done" }),
        noted: eventType()({ data: { type: "object" }, allowedIn: "any", to: null }),
      },
      initial: "opened",
      reduce: () => null,
      project: (s) => s.id,
      body: "none",
      layout: { bodies: null, events: "events" },
      defaultRoot: "log",
      options: undefined,
    });
    const data: DataArbs<typeof task> = {
      opened: () => fc.constant({}),
      done: () => fc.constant({}),
      noted: () => fc.constant({}),
    };
    await fc.assert(
      fc.asyncProperty(arbLegalHistory(task, { data }), fc.gen(), async (h, g) => {
        const snap = await loadLog(new MemoryTree(h.files), {
          kind: compileKind(task),
          layout: h.layout,
        });
        const done = [...foldLog(task, snap).subjects.values()].filter((s) => s.status === "done");
        fc.pre(done.length > 0);
        const arb = arbSemanticTamper(h, { kind: task, data, only: ["illegal-transition"] });
        if (arb === null) throw new Error("a done task always has an illegal transition");
        const m = g(() => arb);
        expect(done.map((s) => `log/events/${s.id}/`).some((p) => m.path.startsWith(p))).toBe(true);
        expect((await verify(task, h, applySemanticTamper(h.files, m), "all"))[0]?.message).toMatch(
          /; done is terminal$/,
        );
        expect(arbSemanticTamper(h, { kind: task, data, only: ["body-without-events"] })).toBe(
          null,
        );
      }),
      { numRuns: 30 },
    );
  });

  it("return null when no allowed tamper type has a candidate", () => {
    const unpublished: DataArbs<typeof widget> = { ...widgetData, published: () => null };
    const h = fc.sample(arbLegalHistory(widget, { data: unpublished, body }), {
      numRuns: 20,
      seed: 7,
    });
    for (const x of h) {
      expect(
        arbSemanticTamper(x, { kind: widget, data: unpublished, only: ["missing-reason"] }),
      ).toBe(null);
      expect(arbSemanticTamper(x, { kind: widget, data: unpublished })).not.toBe(null);
    }
  });

  it("never overwrite a file", () => {
    const m: SemanticTamper = { type: "not-initial", path: "a", content: "x" };
    expect(applySemanticTamper({}, m)).toEqual({ a: "x" });
    expect(() => applySemanticTamper({ a: "y" }, m)).toThrow(InvalidArgumentError);
  });
});
