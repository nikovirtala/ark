import { describe, expect, expectTypeOf, it } from "vitest";
import { compileKind, type KindSchema } from "../envelope/kind.js";
import { KindDefinitionError } from "../errors.js";
import { exampleKind } from "../testing/example-kind.js";
import { exampleMachineKind } from "../testing/example-machine-kind.js";
import { defineKind, eventType, isKind } from "./define.js";
import type { DataOfType, EventTypesOf, StateOf, StatesOf, ViewOf } from "./types.js";

/** A minimal valid definition: tasks are opened, closed and noted. */
const base = {
  name: "task",
  schema: "task/v2",
  states: ["open", "closed"],
  events: {
    opened: {
      data: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", minLength: 1 } },
      },
      allowedIn: [],
      to: "open",
    },
    closed: { data: { type: "object" }, allowedIn: ["open"], to: "closed", reason: "required" },
    noted: { data: { type: "object" }, allowedIn: "any", to: null },
  },
  initial: "opened",
  reduce: (_state: null, _e: unknown) => null,
  project: (s: { id: string }) => s.id,
  body: "none",
  layout: { bodies: null, events: "events" },
  defaultRoot: "tasks",
  options: undefined,
} as const;

/** `defineKind` on `base` with some fields replaced; the typed cases are `exampleMachineKind`'s. */
const define = (patch: Record<string, unknown>) => defineKind({ ...base, ...patch } as never);
const events = (patch: Record<string, unknown>) => ({ ...base.events, ...patch });
const obj = { type: "object" } as const;

const event = {
  envelope: "ledger/v1",
  kind: "task",
  schema: "task/v2",
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  subject: "a7c2m9xd",
  type: "opened",
  at: "2026-03-14T12:02:11Z",
  actor: { kind: "human", name: "Ada" },
  data: { title: "Ship it" },
} as const;

describe("defineKind", () => {
  const templates = { dir: "templates", nameField: "template", versionField: "template_version" };
  const invalid: [name: string, patch: Record<string, unknown>, message: string][] = [
    ["no states", { states: [] }, "kind task: states must not be empty"],
    [
      "a duplicate state",
      { states: ["open", "closed", "open"] },
      'kind task: state "open" is listed twice',
    ],
    [
      "an invalid state name",
      { states: ["open", "Closed"] },
      'kind task: invalid state name "Closed"',
    ],
    [
      "an allowedIn entry that is not a state",
      { events: events({ noted: { data: obj, allowedIn: ["done"], to: null } }) },
      'kind task: event type "noted": allowedIn names unknown state "done"',
    ],
    [
      "a to that is not a state",
      { events: events({ closed: { data: obj, allowedIn: ["open"], to: "done" } }) },
      'kind task: event type "closed": to names unknown state "done"',
    ],
    [
      "an initial that is not an event type",
      { initial: "created" },
      'kind task: initial type "created" is not an event type',
    ],
    [
      "an initial that does not change state",
      { events: events({ opened: { data: obj, allowedIn: [], to: null } }) },
      'kind task: initial type "opened" must change state',
    ],
    [
      "an initial allowed in a state",
      { events: events({ opened: { data: obj, allowedIn: ["open"], to: "open" } }) },
      'kind task: initial type "opened" must have allowedIn: [] (first event only)',
    ],
    [
      "an initial allowed in any state",
      { events: events({ opened: { data: obj, allowedIn: "any", to: "open" } }) },
      'kind task: initial type "opened" must have allowedIn: [] (first event only)',
    ],
    [
      "another type that could never be applied",
      { events: events({ noted: { data: obj, allowedIn: [], to: null } }) },
      'kind task: event type "noted": allowedIn is empty, so it could never be applied',
    ],
    [
      "a freezeOn that is not an event type",
      { body: { freezeOn: "frozen" }, layout: { bodies: "items", events: "events" } },
      'kind task: freezeOn type "frozen" is not an event type',
    ],
    [
      "a freezeOn that does not change state",
      { body: { freezeOn: "noted" }, layout: { bodies: "items", events: "events" } },
      'kind task: freezeOn type "noted" must change state',
    ],
    [
      "a numbering.on that is not an event type",
      { numbering: { on: "accepted", format: String, parse: () => null } },
      'kind task: numbering.on "accepted" is not an event type',
    ],
    [
      "a templates.lintOn that is not an event type",
      { templates: { ...templates, lintIn: ["open"], lintOn: "accepted" } },
      'kind task: templates.lintOn "accepted" is not an event type',
    ],
    [
      "a scope.event that is not an event type",
      { scope: { event: "scoped", activeIn: ["open"] } },
      'kind task: scope.event "scoped" is not an event type',
    ],
    [
      "a templates.lintIn state that does not exist",
      { templates: { ...templates, lintIn: ["proposed"] } },
      'kind task: templates.lintIn names unknown state "proposed"',
    ],
    [
      "a scope.activeIn state that does not exist",
      { scope: { event: "noted", activeIn: ["open", "accepted"] } },
      'kind task: scope.activeIn names unknown state "accepted"',
    ],
    [
      "a schema without a version",
      { schema: "task" },
      'kind task: schema "task" must be "task/v<n>"',
    ],
    [
      "a schema of another kind",
      { schema: "issue/v1" },
      'kind task: schema "issue/v1" must be "task/v<n>"',
    ],
    [
      "a schema version 0",
      { schema: "task/v0" },
      'kind task: schema "task/v0" must be "task/v<n>"',
    ],
    [
      "a schema also in previousSchemas",
      { previousSchemas: { "task/v2": { events: {} } } },
      'kind task: schema "task/v2" is also listed in previousSchemas',
    ],
    [
      "bodies for a kind without bodies",
      { layout: { bodies: "items", events: "events" } },
      'kind task: layout.bodies must be null when body is "none"',
    ],
    [
      "no bodies for a kind with bodies",
      { body: "mutable" },
      'kind task: layout.bodies must be set when body is not "none"',
    ],
    [
      "an invalid defaultRoot",
      { defaultRoot: "../tasks" },
      'kind task: defaultRoot layout root "../tasks" must not contain ..',
    ],
  ];

  for (const [name, patch, message] of invalid) {
    it(`throws KindDefinitionError for ${name}`, () => {
      expect(() => define(patch)).toThrow(KindDefinitionError);
      expect(() => define(patch)).toThrow(message);
      try {
        define(patch);
      } catch (e) {
        expect(e).toMatchObject({ code: "kind-definition", kind: "task" });
      }
    });
  }

  it("surfaces compileKind's data-schema errors at definition time", () => {
    const strict = { data: { type: "object", additionalProperties: false }, allowedIn: "any" };
    expect(() => define({ events: events({ noted: { ...strict, to: null } }) })).toThrow(
      KindDefinitionError,
    );
    expect(() => define({ name: "Task", schema: "Task/v1" })).toThrow("invalid kind name");
  });

  it("returns a frozen, branded KindSchema that compileKind validates", () => {
    const kind = define({});
    expect(Object.isFrozen(kind)).toBe(true);
    expect(isKind(kind)).toBe(true);
    expect(kind).toMatchObject({
      name: "task",
      schema: "task/v2",
      body: "none",
      sourceName: "task",
    });
    const compiled = compileKind(kind);
    expect(compiled.validate(event, { file: null })).toMatchObject({ ok: true });
    expect(compiled.validate({ ...event, data: {} }, { file: null }).findings).toEqual([
      expect.objectContaining({ rule: "data/schema" }),
    ]);
    const closed = { ...event, type: "closed", data: {} };
    expect(compiled.validate(closed, { file: null }).findings).toEqual([
      expect.objectContaining({ rule: "event/reason-required" }),
    ]);
    expect(compiled.validate({ ...closed, reason: "done" }, { file: null }).ok).toBe(true);
  });

  it("builds the current schema from the event types and keeps previous ones readable", () => {
    const v1 = { "task/v1": { events: { opened: { data: obj } } } };
    const kind = define({ previousSchemas: v1 });
    expect(kind.schemas).toEqual({
      ...v1,
      "task/v2": {
        events: {
          opened: { data: base.events.opened.data, reason: "optional" },
          closed: { data: obj, reason: "required" },
          noted: { data: obj, reason: "optional" },
        },
      },
    });
    const old = { ...event, schema: "task/v1", data: {} };
    expect(compileKind(kind).validate(old, { file: null }).ok).toBe(true);
  });

  it("derives the layout and source name", () => {
    const kind = define({ sourceName: "work" });
    expect(kind.sourceName).toBe("work");
    expect(kind.layoutAt("./docs/tasks/")).toEqual({
      root: "docs/tasks",
      bodies: null,
      events: "events",
    });
    expect(exampleMachineKind.layoutAt("log")).toEqual({
      root: "log",
      bodies: "items",
      events: "events",
    });
  });

  it("brands only kinds it returned", () => {
    expect(isKind(exampleMachineKind)).toBe(true);
    expect(isKind(exampleKind)).toBe(false);
    const copy: KindSchema = { ...exampleMachineKind };
    expect(isKind(copy)).toBe(false);
  });

  it("infers states, event types and data types", () => {
    type K = typeof exampleMachineKind;
    expectTypeOf<StatesOf<K>>().toEqualTypeOf<"draft" | "published" | "retired">();
    expectTypeOf<EventTypesOf<K>>().toEqualTypeOf<
      "created" | "noted" | "published" | "retired" | "revived"
    >();
    expectTypeOf<DataOfType<K, "created">>().toEqualTypeOf<{ title: string }>();
    expectTypeOf<StateOf<K>>().toHaveProperty("title");
    expectTypeOf<ViewOf<K>>().toHaveProperty("display");
    const typed = eventType<{ by: string }>()({ data: {}, allowedIn: ["a"], to: "b" });
    expectTypeOf(typed.to).toEqualTypeOf<"a" | "b" | null>();
  });
});
