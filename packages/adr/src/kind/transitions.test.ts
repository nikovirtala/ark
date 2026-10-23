import { describe, expect, it } from "vitest";
import { adrKind } from "../kind.js";
import {
  COMPILED,
  decisionEvent,
  decisionFiles,
  foldFiles,
  hashOf,
  proposedData,
} from "../test-support/events.js";

type State = "proposed" | "accepted" | "rejected" | "withdrawn" | "deprecated" | "superseded";
type Type =
  | "proposed"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "deprecated"
  | "superseded"
  | "noted"
  | "linked"
  | "scoped";

const STATES: readonly State[] = [
  "proposed",
  "accepted",
  "rejected",
  "withdrawn",
  "deprecated",
  "superseded",
];
const TYPES: readonly Type[] = [
  "proposed",
  "accepted",
  "rejected",
  "withdrawn",
  "deprecated",
  "superseded",
  "noted",
  "linked",
  "scoped",
];

/**
 * 01:128–136 and 01:160–165 by hand, independent of `adrKind`: the status an event leads to in
 * each state ("same" when it doesn't change state), or absent when the event is not allowed there.
 */
const TABLE: Readonly<Record<State, Partial<Record<Type, State | "same">>>> = {
  proposed: {
    accepted: "accepted",
    rejected: "rejected",
    withdrawn: "withdrawn",
    noted: "same",
    linked: "same",
    scoped: "same",
  },
  accepted: {
    deprecated: "deprecated",
    superseded: "superseded",
    noted: "same",
    linked: "same",
    scoped: "same",
  },
  deprecated: { superseded: "superseded", noted: "same", linked: "same", scoped: "same" },
  rejected: { noted: "same", linked: "same" },
  withdrawn: { noted: "same", linked: "same" },
  superseded: { noted: "same", linked: "same" },
};

const SUBJECT = "a7c2m9xd";
const OTHER = "k3f9q8a1";
const BODY = "# Use DynamoDB\n";

/** The events that take a decision from nothing to `state`. */
const PATH: Readonly<Record<State, readonly Type[]>> = {
  proposed: ["proposed"],
  accepted: ["proposed", "accepted"],
  rejected: ["proposed", "rejected"],
  withdrawn: ["proposed", "withdrawn"],
  deprecated: ["proposed", "accepted", "deprecated"],
  superseded: ["proposed", "accepted", "superseded"],
};

const DATA: Readonly<Record<Type, Record<string, unknown>>> = {
  proposed: proposedData("Use DynamoDB"),
  accepted: { body_sha256: hashOf(BODY) },
  rejected: {},
  withdrawn: {},
  deprecated: {},
  superseded: { by: OTHER },
  noted: { text: "a note" },
  linked: { to: OTHER, rel: "relates-to" },
  scoped: { set: ["src/**"] },
};
const REASON: Partial<Record<Type, string>> = { rejected: "too costly", deprecated: "obsolete" };

const eventOf = (type: Type) =>
  decisionEvent(SUBJECT, type, {
    data: DATA[type],
    ...(REASON[type] === undefined ? {} : { reason: REASON[type] }),
  });

describe("decision transitions (AC 3)", () => {
  const pairs = STATES.flatMap((state) => TYPES.map((type) => [state, type] as const));
  it.each(pairs)("%s + %s follows the reference table", async (state, type) => {
    const events = [...PATH[state].map(eventOf), eventOf(type)];
    const last = events.at(-1);
    const log = await foldFiles(decisionFiles([{ id: SUBJECT, body: BODY, events }]));
    const s = log.subjects.get(SUBJECT);
    const want = TABLE[state][type];
    expect(s?.applied.map((a) => a.event.type)).toEqual(
      want === undefined ? PATH[state] : [...PATH[state], type],
    );
    expect(s?.status).toBe(want === undefined || want === "same" ? state : want);
    expect(s?.skipped.map((x) => x.event.id)).toEqual(want === undefined ? [last?.id] : []);
    expect(s?.findings.map((f) => f.rule)).toEqual(
      want === undefined ? ["transition/illegal"] : [],
    );
    expect(adrKind.machine.allowed(state, type)).toBe(want !== undefined);
  });

  it("names the terminal state in the illegal-transition message", async () => {
    const events = [...PATH.rejected.map(eventOf), eventOf("accepted")];
    const log = await foldFiles(decisionFiles([{ id: SUBJECT, body: BODY, events }]));
    expect(log.subjects.get(SUBJECT)?.findings[0]?.message).toBe(
      "accepted is not allowed while rejected; rejected is terminal",
    );
  });
});

describe("required reasons (AC 4)", () => {
  const cases = [
    ["rejected", PATH.proposed],
    ["deprecated", PATH.accepted],
  ] as const;
  for (const [type, before] of cases) {
    // The envelope schema already refuses an empty string; blank ones reach the kind's rule.
    for (const [reason, rule] of [
      [undefined, "event/reason-required"],
      [null, "event/reason-required"],
      ["   ", "event/reason-required"],
      ["", "envelope/schema"],
    ] as const) {
      it(`refuses ${type} with reason ${JSON.stringify(reason)}`, async () => {
        const event = decisionEvent(SUBJECT, type, { ...(reason === undefined ? {} : { reason }) });
        const v = COMPILED.validate(event, { file: null });
        expect(v.ok).toBe(false);
        expect(v.findings.map((f) => f.rule)).toEqual([rule]);
        const events = [...before.map(eventOf), event];
        const log = await foldFiles(decisionFiles([{ id: SUBJECT, body: BODY, events }]));
        const s = log.subjects.get(SUBJECT);
        expect(s?.status).toBe(before.length === 1 ? "proposed" : "accepted");
        expect(s?.applied.map((a) => a.event.type)).toEqual(before);
        expect(s?.loaded.events.flatMap((e) => e.findings.map((f) => f.rule))).toEqual([rule]);
      });
    }
    it(`accepts ${type} with a reason`, () => {
      const event = decisionEvent(SUBJECT, type, { reason: "because" });
      expect(COMPILED.validate(event, { file: null }).ok).toBe(true);
    });
  }

  it("leaves the reason optional for the other types", () => {
    for (const type of TYPES.filter((t) => REASON[t] === undefined)) {
      expect(
        COMPILED.validate(decisionEvent(SUBJECT, type, { data: DATA[type] }), { file: null }).ok,
      ).toBe(true);
    }
  });
});
