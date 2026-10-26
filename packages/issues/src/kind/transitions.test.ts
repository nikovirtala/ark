import type { EventEnvelope } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { issueKind } from "../kind.js";
import { foldFiles, issueEvent, issueFiles, opened } from "../test-support/events.js";

type State = "open" | "in-progress" | "closed";
type Type =
  | "opened"
  | "started"
  | "stopped"
  | "closed"
  | "reopened"
  | "assigned"
  | "labeled"
  | "commented"
  | "linked"
  | "unlinked"
  | "scoped";

const STATES: readonly State[] = ["open", "in-progress", "closed"];
const TYPES: readonly Type[] = [
  "opened",
  "started",
  "stopped",
  "closed",
  "reopened",
  "assigned",
  "labeled",
  "commented",
  "linked",
  "unlinked",
  "scoped",
];

/**
 * The design's state machine table by hand, independent of `issueKind`: the state an event leads
 * to in each state ("same" when it doesn't change state), or absent when it is illegal there.
 */
const TABLE: Readonly<Record<State, Partial<Record<Type, State | "same">>>> = {
  open: {
    started: "in-progress",
    closed: "closed",
    assigned: "same",
    labeled: "same",
    commented: "same",
    linked: "same",
    unlinked: "same",
    scoped: "same",
  },
  "in-progress": {
    stopped: "open",
    closed: "closed",
    assigned: "same",
    labeled: "same",
    commented: "same",
    linked: "same",
    unlinked: "same",
    scoped: "same",
  },
  closed: {
    reopened: "open",
    assigned: "same",
    labeled: "same",
    commented: "same",
    linked: "same",
    unlinked: "same",
    scoped: "same",
  },
};

const S = "aaaaaaaa";
const T = "bbbbbbbb";

/** Valid data and reason for one event of each type. */
function eventOf(type: Type, at: string): EventEnvelope {
  const data: Record<Type, Record<string, unknown>> = {
    opened: { title: "Again", template: "task", template_version: 1 },
    started: {},
    stopped: {},
    closed: { resolution: "done" },
    reopened: {},
    assigned: { set: ["a@example.com"] },
    labeled: { set: ["type:bug"] },
    commented: { text: "hi" },
    linked: { to: T, rel: "relates-to" },
    unlinked: { to: T, rel: "relates-to" },
    scoped: { set: ["src/**"] },
  };
  return issueEvent(S, type, {
    data: data[type],
    at,
    ...(type === "reopened" ? { reason: "again" } : {}),
  });
}

/** Events that bring S into `state`. */
function into(state: State): EventEnvelope[] {
  const o = opened(S);
  const fixed = (e: EventEnvelope, at: string) => ({ ...e, at });
  const base = [fixed(o, "2026-10-20T09:00:00Z")];
  if (state === "in-progress") base.push(eventOf("started", "2026-10-20T09:01:00Z"));
  if (state === "closed") base.push(eventOf("closed", "2026-10-20T09:01:00Z"));
  return base;
}

describe("the state machine, every event type in every state", () => {
  for (const state of STATES) {
    for (const type of TYPES) {
      const expected = TABLE[state][type];
      it(`${type} while ${state}: ${expected === undefined ? "illegal" : `→ ${expected}`}`, async () => {
        const events = [...into(state), eventOf(type, "2026-10-20T10:00:00Z")];
        const log = await foldFiles(
          issueFiles([
            { id: S, events },
            { id: T, events: [opened(T)] },
          ]),
        );
        const s = log.subjects.get(S);
        expect(issueKind.machine.allowed(state, type)).toBe(expected !== undefined);
        if (expected === undefined) {
          expect(s?.status).toBe(state);
          expect(s?.skipped.map((x) => x.rule)).toEqual(["transition/illegal"]);
        } else {
          expect(s?.status).toBe(expected === "same" ? state : expected);
          expect(s?.skipped).toEqual([]);
        }
      });
    }
  }

  it("refuses any first event other than opened (transition/not-initial)", async () => {
    for (const type of TYPES.filter((t) => t !== "opened")) {
      const log = await foldFiles(
        issueFiles([{ id: S, events: [eventOf(type, "2026-10-20T10:00:00Z")], body: "# x\n" }]),
      );
      const s = log.subjects.get(S);
      expect(s?.status, type).toBeNull();
      expect(
        s?.findings.map((f) => f.rule),
        type,
      ).toContain("transition/not-initial");
    }
  });

  it("requires a reason to reopen", async () => {
    const events = [...into("closed"), { ...eventOf("reopened", "2026-10-20T10:00:00Z") }];
    const last = events[events.length - 1] as EventEnvelope;
    const { reason: _, ...withoutReason } = last;
    const log = await foldFiles(
      issueFiles([{ id: S, events: [...events.slice(0, -1), withoutReason as EventEnvelope] }]),
    );
    expect(log.subjects.get(S)?.status).toBe("closed");
    expect(issueKind.machine.types.get("reopened")?.reason).toBe("required");
  });
});
