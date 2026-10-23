import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KindDefinitionError } from "../errors.js";
import { arbEnvelope, arbUnknownFields } from "../testing/arbitraries.js";
import { compileKind, type KindSchema } from "./kind.js";

// A test-local kind; `exampleKind` arrives with the log layer.
const kind: KindSchema = {
  name: "widget",
  schemas: {
    "widget/v1": {
      events: {
        created: {
          data: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string", minLength: 1 } },
          },
        },
        noted: { data: { type: "object" } },
      },
    },
    "widget/v2": { events: { noted: { data: { type: "object" } } } },
  },
  body: { freezeOn: "created" },
};
const compiled = compileKind(kind);

const arbData = fc
  .tuple(fc.string({ minLength: 1 }), arbUnknownFields(["title"]))
  .map(([title, extra]) => ({ title, ...extra }));
const arbValid = () => arbEnvelope({ kind, data: arbData });
const arbCreated = () => arbEnvelope({ kind, type: "created", data: arbData });

const base = {
  envelope: "ledger/v1",
  kind: "widget",
  schema: "widget/v1",
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  subject: "a7c2m9xd",
  type: "created",
  at: "2026-03-14T12:02:11Z",
  actor: { kind: "human", name: "Ada" },
  data: { title: "Use DynamoDB" },
} as const;

const validate = (doc: unknown) => compiled.validate(doc, { file: "e.yaml" });
const rules = (doc: unknown) => validate(doc).findings.map((f) => f.rule);

describe("compileKind(…).validate", () => {
  it("accepts generated valid envelopes, including unknown fields", () => {
    fc.assert(
      fc.property(arbValid(), (e) => {
        expect(validate(e)).toEqual({ ok: true, event: e, findings: [] });
      }),
    );
  });

  it("returns the document unchanged as the event", () => {
    const doc = { ...base, extra: { nested: [1] } };
    const r = validate(doc);
    expect(r.ok && r.event).toBe(doc);
  });

  const corruptions: [name: string, rule: string, change: (e: Record<string, unknown>) => void][] =
    [
      ...["envelope", "kind", "schema", "id", "subject", "type", "at", "actor", "data"].map(
        (field): [string, string, (e: Record<string, unknown>) => void] => [
          `drop ${field}`,
          "envelope/schema",
          (e) => {
            delete e[field];
          },
        ],
      ),
      ...["envelope", "kind", "schema", "id", "subject", "type", "at", "actor", "data"].map(
        (field): [string, string, (e: Record<string, unknown>) => void] => [
          `${field} of the wrong type`,
          "envelope/schema",
          (e) => {
            e[field] = field === "data" || field === "actor" ? [] : 42;
          },
        ],
      ),
      [
        "lowercase id",
        "envelope/schema",
        (e) => {
          e.id = String(e.id).toLowerCase();
        },
      ],
      [
        "short id",
        "envelope/schema",
        (e) => {
          e.id = "01JAD7Q2M8K4X9ZT";
        },
      ],
      [
        "uppercase subject",
        "envelope/schema",
        (e) => {
          e.subject = "A7C2M9XD";
        },
      ],
      [
        "bad at",
        "envelope/schema",
        (e) => {
          e.at = "2026-03-14 12:02:11";
        },
      ],
      [
        "Feb 30",
        "envelope/schema",
        (e) => {
          e.at = "2026-02-30T12:00:00Z";
        },
      ],
      [
        "bad actor kind",
        "envelope/schema",
        (e) => {
          e.actor = { kind: "robot", name: "x" };
        },
      ],
      [
        "empty actor name",
        "envelope/schema",
        (e) => {
          e.actor = { kind: "human", name: "" };
        },
      ],
      [
        "empty reason",
        "envelope/schema",
        (e) => {
          e.reason = "";
        },
      ],
      [
        "foreign kind",
        "envelope/kind-mismatch",
        (e) => {
          e.kind = "gadget";
        },
      ],
      [
        "unknown schema",
        "envelope/unknown-schema",
        (e) => {
          e.schema = "widget/v9";
        },
      ],
      [
        "unknown type",
        "envelope/unknown-type",
        (e) => {
          e.type = "archived";
        },
      ],
      [
        "type from another version",
        "envelope/unknown-type",
        (e) => {
          e.schema = "widget/v2";
        },
      ],
      [
        "invalid data",
        "data/schema",
        (e) => {
          e.data = { title: 42 };
        },
      ],
      [
        "missing data field",
        "data/schema",
        (e) => {
          e.data = {};
        },
      ],
    ];

  for (const [name, rule, change] of corruptions) {
    it(`reports exactly ${rule} for: ${name}`, () => {
      fc.assert(
        fc.property(arbCreated(), (e) => {
          const doc = structuredClone(e) as unknown as Record<string, unknown>;
          change(doc);
          const found = rules(doc);
          expect(found.length).toBeGreaterThan(0);
          expect(new Set(found)).toEqual(new Set([rule]));
        }),
        { numRuns: 20 },
      );
    });
  }

  it("reports a calendar-invalid at with a clear message", () => {
    expect(validate({ ...base, at: "2026-02-30T12:00:00Z" }).findings).toEqual([
      expect.objectContaining({ message: "/at: not a valid UTC timestamp", file: "e.yaml" }),
    ]);
  });

  it("marks unknown schemas as not known to this reader", () => {
    expect(validate({ ...base, schema: "widget/v9" })).toMatchObject({
      ok: false,
      versionKnown: false,
    });
    expect(validate({ ...base, type: "archived" })).toMatchObject({
      ok: false,
      versionKnown: true,
    });
  });

  it("reports only envelope/unknown-version for any other envelope string", () => {
    fc.assert(
      fc.property(
        arbValid(),
        fc.string().filter((s) => s !== "ledger/v1"),
        (e, version) => {
          const { id: _, ...doc } = { ...e, envelope: version, data: 7 };
          const r = validate(doc);
          expect(r).toMatchObject({ ok: false, versionKnown: false });
          expect(r.findings).toEqual([
            expect.objectContaining({
              rule: "envelope/unknown-version",
              message: `unknown envelope version ${JSON.stringify(version)}; upgrade the tool to read this event`,
            }),
          ]);
        },
      ),
    );
  });

  it("reports a non-mapping document as event/not-a-mapping", () => {
    for (const doc of [null, 1, "x", [base]]) expect(rules(doc)).toEqual(["event/not-a-mapping"]);
  });

  it("gives exactly one finding for an agent actor without agent", () => {
    const r = validate({ ...base, actor: { kind: "agent", name: "Ada" } });
    expect(r.findings).toEqual([
      {
        severity: "error",
        rule: "envelope/schema",
        message: "/actor: must have required property 'agent'",
        file: "e.yaml",
        line: null,
        subject: null,
        kind: null,
      },
    ]);
    expect(rules({ ...base, actor: { kind: "agent", name: "Ada", agent: "" } })).toEqual([
      "envelope/schema",
    ]);
    expect(validate({ ...base, actor: { kind: "agent", name: "Ada", agent: "bot" } }).ok).toBe(
      true,
    );
  });

  it("reports only the leaf errors of an if/then data schema", () => {
    const k = compileKind({
      name: "task",
      schemas: {
        "task/v1": {
          events: {
            changed: {
              data: {
                type: "object",
                properties: { state: { type: "string" } },
                if: { properties: { state: { const: "done" } }, required: ["state"] },
                // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword
                then: { required: ["closed_at"], properties: { closed_at: { type: "string" } } },
              },
            },
          },
        },
      },
      body: "none",
    });
    const doc = {
      ...base,
      kind: "task",
      schema: "task/v1",
      type: "changed",
      data: { state: "done" },
    };
    expect(k.validate(doc, { file: null }).findings.map((f) => f.message)).toEqual([
      "/data: must have required property 'closed_at'",
    ]);
  });

  it("caps schema findings at 10 per file", () => {
    const fields = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const k = compileKind({
      name: "many",
      schemas: {
        "many/v1": {
          events: {
            made: {
              data: {
                type: "object",
                required: fields,
                properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])),
              },
            },
          },
        },
      },
      body: "none",
    });
    const doc = { ...base, kind: "many", schema: "many/v1", type: "made", data: {} };
    expect(k.validate(doc, { file: null }).findings).toHaveLength(10);
    const bad = { envelope: "ledger/v1", actor: { kind: "agent", email: 5 }, reason: "", data: [] };
    expect(validate(bad).findings).toHaveLength(10);
  });
});

describe("required reasons", () => {
  const k = compileKind({
    name: "widget",
    schemas: {
      "widget/v1": {
        events: {
          created: { data: { type: "object" } },
          retired: { data: { type: "object" }, reason: "required" },
          noted: { data: { type: "object" }, reason: "optional" },
        },
      },
    },
    body: "none",
  });
  const doc = { ...base, type: "retired", data: {} };
  const check = (d: unknown) => k.validate(d, { file: "e.yaml" });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["blank", " \t\n "],
  ])("reports event/reason-required when the reason is %s", (_, reason) => {
    const r = check(reason === undefined ? doc : { ...doc, reason });
    expect(r).toMatchObject({ ok: false, versionKnown: true });
    expect(r.findings).toEqual([
      expect.objectContaining({
        rule: "event/reason-required",
        message: "retired events need a reason",
        file: "e.yaml",
      }),
    ]);
  });

  it("accepts a non-blank reason", () => {
    expect(check({ ...doc, reason: "obsolete" }).ok).toBe(true);
  });

  it("leaves types without a required reason unchanged", () => {
    expect(check({ ...doc, type: "noted" }).ok).toBe(true);
    expect(check({ ...doc, type: "created", reason: null }).ok).toBe(true);
    expect(rules({ ...base, reason: null })).toEqual([]);
  });

  it("checks the data schema first", () => {
    const strict = compileKind({
      name: "widget",
      schemas: {
        "widget/v1": {
          events: {
            retired: {
              data: { type: "object", required: ["by"], properties: { by: { type: "string" } } },
              reason: "required",
            },
          },
        },
      },
      body: "none",
    });
    expect(strict.validate(doc, { file: null }).findings.map((f) => f.rule)).toEqual([
      "data/schema",
    ]);
  });
});

describe("compileKind", () => {
  const withData = (data: unknown): KindSchema => ({
    name: "widget",
    schemas: { "widget/v1": { events: { created: { data: data as Record<string, unknown> } } } },
    body: "none",
  });

  it("memoizes per kind object", () => {
    expect(compileKind(kind)).toBe(compiled);
    expect(compileKind({ ...kind })).not.toBe(compiled);
  });

  const invalid: [name: string, kind: KindSchema][] = [
    ["an invalid kind name", { ...withData({ type: "object" }), name: "Widget" }],
    [
      "a schema key without a version",
      { name: "widget", schemas: { widget: { events: {} } }, body: "none" },
    ],
    [
      "a schema key of another kind",
      { name: "widget", schemas: { "gadget/v1": { events: {} } }, body: "none" },
    ],
    [
      "an invalid event type",
      {
        name: "widget",
        schemas: { "widget/v1": { events: { Created: { data: { type: "object" } } } } },
        body: "none",
      },
    ],
    ["a non-object data schema", withData({ type: "string" })],
    ["a boolean data schema", withData(true)],
    [
      "a top-level additionalProperties: false",
      withData({ type: "object", additionalProperties: false }),
    ],
    [
      "a top-level unevaluatedProperties: false",
      withData({ type: "object", unevaluatedProperties: false }),
    ],
    ["an unknown keyword (strict mode)", withData({ type: "object", colour: "red" })],
    [
      "a keyword without its type (strict mode)",
      withData({ type: "object", properties: { a: { minLength: 1 } } }),
    ],
    [
      "a freezeOn type no version defines",
      { ...withData({ type: "object" }), body: { freezeOn: "accepted" } },
    ],
  ];

  for (const [name, k] of invalid) {
    it(`throws KindDefinitionError for ${name}`, () => {
      expect(() => compileKind(k)).toThrow(KindDefinitionError);
      try {
        compileKind(k);
      } catch (e) {
        expect(e).toMatchObject({ code: "kind-definition", kind: k.name });
      }
    });
  }

  it("keeps nested additionalProperties: false", () => {
    expect(() =>
      compileKind(
        withData({
          type: "object",
          properties: { nested: { type: "object", additionalProperties: false } },
        }),
      ),
    ).not.toThrow();
  });
});
