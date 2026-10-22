import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import {
  arbAt,
  arbEventFileName,
  arbEventType,
  arbSlug,
  arbSubjectId,
  arbUlid,
} from "../testing/arbitraries.js";
import {
  bodyFileName,
  eventFileName,
  formatEventFileName,
  isEventType,
  parseBodyFileName,
  parseEventFileName,
  slugify,
} from "./files.js";
import { atToStamp } from "./time.js";

describe("event file names", () => {
  it("derives the name from at, id and type", () => {
    expect(
      eventFileName({
        at: "2026-03-14T12:02:11Z",
        id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
        type: "accepted",
      }),
    ).toBe("20260314T120211Z-q8a1-accepted.yaml");
  });

  it("round-trips parse and format", () => {
    fc.assert(
      fc.property(arbEventFileName(), (n) => {
        expect(parseEventFileName(formatEventFileName(n))).toEqual(n);
      }),
    );
    fc.assert(
      fc.property(fc.record({ at: arbAt(), id: arbUlid(), type: arbEventType() }), (e) => {
        expect(parseEventFileName(eventFileName(e))).toEqual({
          stamp: atToStamp(e.at),
          rand: e.id.slice(-4).toLowerCase(),
          type: e.type,
        });
      }),
    );
  });

  it("throws for invalid inputs and parses invalid names to null", () => {
    const e = { at: "2026-03-14T12:02:11Z", id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1", type: "accepted" };
    expect(() => eventFileName({ ...e, at: "2026-02-30T00:00:00Z" })).toThrow(InvalidArgumentError);
    expect(() => eventFileName({ ...e, id: "01jab3k9z6q8m2x7fq0v4tq8a1" })).toThrow(
      InvalidArgumentError,
    );
    expect(() => eventFileName({ ...e, type: "Accepted" })).toThrow(InvalidArgumentError);
    expect(() =>
      formatEventFileName({ stamp: "20260314T120211Z", rand: "q8i1", type: "accepted" }),
    ).toThrow(InvalidArgumentError);
    for (const name of [
      "20260314T120211Z-q8a1-accepted.yml",
      "20260314T120211Z-Q8A1-accepted.yaml",
      "20260314T120211-q8a1-accepted.yaml",
      "20260314T120211Z-q8a1-accepted-.yaml",
      "20260314T120211Z-q8a1-.yaml",
      `20260314T120211Z-q8a1-${"a".repeat(65)}.yaml`,
      ".gitkeep",
    ]) {
      expect(parseEventFileName(name)).toBeNull();
    }
  });

  it("limits event types to 64 kebab-case chars", () => {
    expect(isEventType("a".repeat(64))).toBe(true);
    expect(isEventType("a".repeat(65))).toBe(false);
    expect(isEventType("status-changed2")).toBe(true);
    for (const bad of ["", "2x", "a--b", "a_b", "A", "-a", 1]) expect(isEventType(bad)).toBe(false);
  });
});

describe("slugify", () => {
  it("makes ASCII kebab-case slugs", () => {
    expect(slugify("Use DynamoDB for orders")).toBe("use-dynamodb-for-orders");
    expect(slugify("  Crème brûlée — à la carte!  ")).toBe("creme-brulee-a-la-carte");
    expect(slugify("ﬁle №1")).toBe("file-no1");
    expect(slugify("!!!")).toBe("");
    expect(slugify("日本語")).toBe("");
  });

  it("cuts at a dash within max", () => {
    expect(slugify("aaa bbb ccc", 7)).toBe("aaa-bbb");
    expect(slugify("aaa bbb ccc", 8)).toBe("aaa-bbb");
    expect(slugify("aaa bbb ccc", 6)).toBe("aaa");
    expect(slugify("abcdefghij", 4)).toBe("abcd");
    expect(slugify("a".repeat(100))).toHaveLength(60);
  });

  it("is idempotent and conforms to the pattern", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.integer({ min: 1, max: 80 }), (title, max) => {
        const slug = slugify(title, max);
        expect(slug).toMatch(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/);
        expect(slug.length).toBeLessThanOrEqual(max);
        expect(slugify(slug, max)).toBe(slug);
      }),
    );
  });
});

describe("body file names", () => {
  it("round-trips id and slug", () => {
    fc.assert(
      fc.property(arbSubjectId(), arbSlug(), (id, slug) => {
        expect(parseBodyFileName(bodyFileName(id, slug))).toEqual({ id, slug });
      }),
    );
    expect(bodyFileName("a7c2m9xd", "use-dynamodb-for-orders")).toBe(
      "a7c2m9xd-use-dynamodb-for-orders.md",
    );
    expect(bodyFileName("a7c2m9xd", "")).toBe("a7c2m9xd.md");
  });

  it("throws for bad ids or slugs and parses bad names to null", () => {
    expect(() => bodyFileName("A7C2M9XD", "x")).toThrow(InvalidArgumentError);
    expect(() => bodyFileName("a7c2m9xd", "Bad Slug")).toThrow(InvalidArgumentError);
    for (const name of ["a7c2m9xd-.md", "a7c2m9xd-x.txt", "a7c2m9x-x.md", "README.md"]) {
      expect(parseBodyFileName(name)).toBeNull();
    }
  });
});
