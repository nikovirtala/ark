import { describe, expect, it } from "vitest";
import { exampleMachineKind } from "../testing/example-machine-kind.js";
import { defineKind } from "./define.js";

const { machine } = exampleMachineKind;

describe("exampleMachineKind's machine", () => {
  it("has the initial type and the states", () => {
    expect(machine.initial).toEqual({ type: "created", to: "draft" });
    expect(machine.states).toEqual(["draft", "published", "retired"]);
  });

  it("lists the types applicable in each state, in definition order", () => {
    expect(machine.next("draft")).toEqual(["noted", "published"]);
    expect(machine.next("published")).toEqual(["noted", "retired"]);
    expect(machine.next("retired")).toEqual(["noted", "revived"]);
  });

  it("allows types by state and never the initial or an unknown type", () => {
    expect(machine.allowed("draft", "published")).toBe(true);
    expect(machine.allowed("published", "published")).toBe(false);
    expect(machine.allowed("retired", "noted")).toBe(true);
    for (const s of machine.states) {
      expect(machine.allowed(s, "created")).toBe(false);
      expect(machine.allowed(s, "archived")).toBe(false);
    }
  });

  it("has no terminal state, because retired widgets can be revived", () => {
    expect(machine.terminal).toEqual([]);
  });

  it("records each type's rule with reason defaulting to optional", () => {
    expect(machine.types.get("retired")).toEqual({
      allowedIn: ["published"],
      to: "retired",
      reason: "required",
    });
    expect(machine.types.get("noted")).toEqual({ allowedIn: "any", to: null, reason: "optional" });
  });
});

describe("terminal states", () => {
  const kind = (anyChange: boolean) =>
    defineKind({
      name: "task",
      schema: "task/v1",
      states: ["open", "done", "dropped"],
      events: {
        opened: { data: { type: "object" }, allowedIn: [], to: "open" },
        finished: { data: { type: "object" }, allowedIn: ["open"], to: "done" },
        dropped: { data: { type: "object" }, allowedIn: ["open"], to: "dropped" },
        noted: { data: { type: "object" }, allowedIn: "any", to: null },
        ...(anyChange
          ? { reset: { data: { type: "object" }, allowedIn: "any" as const, to: "open" as const } }
          : {}),
      },
      initial: "opened",
      reduce: () => null,
      project: (s) => s.id,
      body: "none",
      layout: { bodies: null, events: "events" },
      defaultRoot: "tasks",
      options: undefined,
    });

  it("are the states where only non-changing types apply", () => {
    expect(kind(false).machine.terminal).toEqual(["done", "dropped"]);
    expect(kind(false).machine.next("done")).toEqual(["noted"]);
  });

  it("don't exist when a state-changing type is allowed anywhere", () => {
    expect(kind(true).machine.terminal).toEqual([]);
  });
});
