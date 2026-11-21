import { describe, expect, it } from "vitest";
import {
  eventsFrom,
  IllegalTransitionError,
  RunMachine,
  TERMINAL_PHASES,
  TRANSITIONS,
  transition,
} from "./machine.js";

describe("the run's state machine, as data", () => {
  it("goes queued, preflight, deploying, smoking, running tasks, succeeded on the happy path", () => {
    const m = new RunMachine();
    for (const e of ["start", "checked", "deployed", "smoke-passed", "tasks-passed"] as const)
      m.fire(e);
    expect(m.path()).toEqual([
      "queued",
      "preflight",
      "deploying",
      "smoking",
      "running-tasks",
      "succeeded",
    ]);
  });

  it("has no way out of a terminal phase: only a person leaves frozen, outside any run", () => {
    for (const p of TERMINAL_PHASES) expect(eventsFrom(p), p).toEqual([]);
    expect(() => transition("frozen", "start")).toThrow(IllegalTransitionError);
  });

  it("freezes before it rolls back, and never rolls back a failed task", () => {
    expect(transition("deploying", "deploy-failed").effects).toEqual([
      "set-freeze",
      "roll-back",
      "notify",
    ]);
    expect(transition("smoking", "smoke-failed").effects).toEqual([
      "set-freeze",
      "roll-back",
      "notify",
    ]);
    expect(transition("running-tasks", "task-failed").effects).toEqual(["set-freeze", "notify"]);
  });

  it("changes nothing and freezes nothing on a refusal before deploying, or a frozen start", () => {
    expect(transition("preflight", "refuse")).toMatchObject({ to: "refused", effects: ["notify"] });
    expect(transition("queued", "found-frozen")).toMatchObject({ to: "frozen", effects: [] });
  });

  it("sets the freeze flag only on the way into frozen, and records the last good commit only on success", () => {
    for (const t of TRANSITIONS) {
      if (t.effects.includes("set-freeze")) expect(t.to).toBe("frozen");
      if (t.effects.includes("roll-back")) expect(["deploying", "smoking"]).toContain(t.from);
      if (t.effects.includes("record-last-good")) expect(t.to).toBe("succeeded");
    }
  });

  it("reaches every phase from queued", () => {
    const reached = new Set(["queued"]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of TRANSITIONS)
        if (reached.has(t.from) && !reached.has(t.to)) {
          reached.add(t.to);
          changed = true;
        }
    }
    expect([...reached].sort()).toEqual([
      "deploying",
      "frozen",
      "preflight",
      "queued",
      "refused",
      "running-tasks",
      "smoking",
      "succeeded",
    ]);
  });
});
