import { describe, expect, it } from "vitest";
import { type JsonValue, UsageError } from "../errors.js";
import {
  checkResourceId,
  doc,
  GLOBS,
  ID,
  MAX_ID,
  type McpSchema,
  object,
  READ,
  SECTIONS,
  SOURCE,
  sectionsOf,
  str,
  strings,
  TEXT,
  WRITE,
} from "./inputs.js";
import { compileInputSchema } from "./validate.js";

/** Whether `{ x: value }` passes `object({ x: schema })`, compiled as `serveMcp` compiles it. */
const accepts = (schema: McpSchema, value: JsonValue): boolean =>
  compileInputSchema("t_x", object({ x: schema }))({ x: value });

const sections = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, "text"]));

describe("the input schemas", () => {
  it("ID takes 1 to MAX_ID characters", () => {
    expect(MAX_ID).toBe(64);
    expect(accepts(ID, "a")).toBe(true);
    expect(accepts(ID, "a".repeat(64))).toBe(true);
    expect(accepts(ID, "a".repeat(65))).toBe(false);
    expect(accepts(ID, "")).toBe(false);
    expect(accepts(ID, 12)).toBe(false);
  });

  it("TEXT takes 1 to 65,536 characters", () => {
    expect(accepts(TEXT, "x")).toBe(true);
    expect(accepts(TEXT, "x".repeat(65_536))).toBe(true);
    expect(accepts(TEXT, "x".repeat(65_537))).toBe(false);
    expect(accepts(TEXT, "")).toBe(false);
  });

  it("SECTIONS maps up to 50 section ids to markdown", () => {
    expect(accepts(SECTIONS, {})).toBe(true);
    expect(accepts(SECTIONS, { context: "", "done-when": "x" })).toBe(true);
    expect(accepts(SECTIONS, sections(50))).toBe(true);
    expect(accepts(SECTIONS, sections(51))).toBe(false);
    expect(accepts(SECTIONS, { Context: "x" })).toBe(false);
    expect(accepts(SECTIONS, { "1st": "x" })).toBe(false);
    expect(accepts(SECTIONS, { [`a${"b".repeat(64)}`]: "x" })).toBe(false);
    expect(accepts(SECTIONS, { context: 1 })).toBe(false);
    expect(accepts(SECTIONS, { context: "x".repeat(65_537) })).toBe(false);
  });

  it("GLOBS takes up to 200 non-empty globs of at most 500 characters", () => {
    expect(accepts(GLOBS, [])).toBe(true);
    expect(accepts(GLOBS, ["src/**", "a".repeat(500)])).toBe(true);
    expect(accepts(GLOBS, ["a".repeat(501)])).toBe(false);
    expect(accepts(GLOBS, [""])).toBe(false);
    expect(
      accepts(
        GLOBS,
        Array.from({ length: 200 }, () => "a"),
      ),
    ).toBe(true);
    expect(
      accepts(
        GLOBS,
        Array.from({ length: 201 }, () => "a"),
      ),
    ).toBe(false);
  });

  it("SOURCE is the source-name rule, anchored", () => {
    expect(SOURCE).toEqual({ type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" });
    expect(accepts(SOURCE, "upstream")).toBe(true);
    expect(accepts(SOURCE, `a${"b".repeat(31)}`)).toBe(true);
    expect(accepts(SOURCE, `a${"b".repeat(32)}`)).toBe(false);
    expect(accepts(SOURCE, "Bad")).toBe(false);
    expect(accepts(SOURCE, "x Bad")).toBe(false);
    expect(accepts(SOURCE, "1x")).toBe(false);
    expect(accepts(SOURCE, "")).toBe(false);
  });
});

describe("object", () => {
  it("leaves required out when nothing is required, and allows no other properties", () => {
    expect(object({ x: ID })).toEqual({
      type: "object",
      properties: { x: ID },
      additionalProperties: false,
    });
    expect(object({ x: ID, y: TEXT }, ["x"])).toEqual({
      type: "object",
      properties: { x: ID, y: TEXT },
      required: ["x"],
      additionalProperties: false,
    });
    const validate = compileInputSchema("t_x", object({ x: ID }, ["x"]));
    expect(validate({ x: "a" })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ x: "a", y: "b" })).toBe(false);
  });
});

describe("the annotations", () => {
  it("mark reads read-only and writes neither read-only nor destructive", () => {
    expect(READ).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(WRITE).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });
});

describe("the argument readers", () => {
  it("str reads strings only", () => {
    expect(str("a")).toBe("a");
    expect(str("")).toBe("");
    expect(str(1)).toBeUndefined();
    expect(str(null)).toBeUndefined();
    expect(str(["a"])).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
  });

  it("strings keeps an array's strings", () => {
    expect(strings(["a", 1, null, "b", ["c"]])).toEqual(["a", "b"]);
    expect(strings([])).toEqual([]);
    expect(strings("a")).toBeUndefined();
    expect(strings({ a: "b" })).toBeUndefined();
    expect(strings(undefined)).toBeUndefined();
  });

  it("sectionsOf keeps an object's string entries", () => {
    expect(sectionsOf({ a: "x", b: 1, c: null, d: "", e: ["y"] })).toEqual({ a: "x", d: "" });
    expect(sectionsOf(["x"])).toEqual({});
    expect(sectionsOf(null)).toEqual({});
    expect(sectionsOf("x")).toEqual({});
    expect(sectionsOf(undefined)).toEqual({});
  });

  it("doc passes a document through unchanged", () => {
    const d = { format: "x/v1", items: [1, "a", null] };
    expect(doc(d)).toBe(d);
  });
});

describe("checkResourceId", () => {
  it("allows an id of MAX_ID characters", () => {
    expect(() => checkResourceId("a".repeat(64), "decision")).not.toThrow();
    expect(() => checkResourceId("", "decision")).not.toThrow();
  });

  it("refuses a longer one with a usage error naming the noun", () => {
    const id = `${"a".repeat(64)}b`;
    for (const noun of ["decision", "issue"]) {
      let err: unknown;
      try {
        checkResourceId(id, noun);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toBe(
        `invalid ${noun} "${"a".repeat(64)}…": an id or number is at most 64 characters`,
      );
    }
  });
});
