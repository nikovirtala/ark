import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { exampleKind, exampleLayout } from "./example-kind.js";
import { arbLogFixture, type LogFixture } from "./log-fixture.js";
import { applyTamper, arbAppend, arbTamper } from "./tamper.js";

const fixtures = () =>
  arbLogFixture({ kind: exampleKind, layout: exampleLayout }).filter((f) => f.subjects.length > 0);
const empty: LogFixture = { kind: exampleKind, layout: exampleLayout, files: {}, subjects: [] };

describe("applyTamper", () => {
  it("returns a changed copy and never mutates its input", () => {
    fc.assert(
      fc.property(
        fixtures().chain((f) => fc.tuple(fc.constant(f), arbTamper(f))),
        ([fixture, m]) => {
          const before = structuredClone(fixture.files);
          const after = applyTamper(fixture.files, m);
          expect(fixture.files).toEqual(before);
          expect(after).not.toEqual(before);
        },
      ),
    );
  });

  it("rejects a mutation that doesn't fit the files", () => {
    expect(() => applyTamper({}, { type: "modify-event", path: "x" })).toThrow(
      InvalidArgumentError,
    );
    expect(() =>
      applyTamper(
        { a: "1" },
        { type: "duplicate-subject-id", subject: "s", path: "a", content: "" },
      ),
    ).toThrow(InvalidArgumentError);
  });
});

describe("arbTamper", () => {
  it("needs something to tamper with", () => {
    expect(() => arbTamper(empty)).toThrow(InvalidArgumentError);
  });
});

describe("arbAppend", () => {
  it("adds one to three new paths only", () => {
    fc.assert(
      fc.property(
        arbLogFixture({ kind: exampleKind, layout: exampleLayout }).chain((f) =>
          fc.tuple(fc.constant(f), arbAppend(f)),
        ),
        ([fixture, append]) => {
          const paths = Object.keys(append);
          expect(paths.length).toBeGreaterThanOrEqual(1);
          expect(paths.length).toBeLessThanOrEqual(3);
          for (const p of paths) expect(Object.hasOwn(fixture.files, p)).toBe(false);
        },
      ),
    );
  });
});
