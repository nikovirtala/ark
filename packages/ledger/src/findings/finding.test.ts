import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exitCode, type Finding, finding, sortFindings, summarize } from "./finding.js";

const arbFinding: fc.Arbitrary<Finding> = fc.record({
  severity: fc.constantFrom("error" as const, "warning" as const),
  rule: fc.constantFrom("a/x", "a/y", "b/x"),
  message: fc.string({ maxLength: 4 }),
  file: fc.option(fc.constantFrom("a.yaml", "b.yaml", "b.md"), { nil: null }),
  line: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
  subject: fc.option(fc.constantFrom("k3f9q8a1", "a7c2m9xd"), { nil: null }),
  kind: fc.option(fc.constantFrom("decision", "issue"), { nil: null }),
});

describe("finding", () => {
  it("fills absent keys with null", () => {
    expect(finding({ severity: "error", rule: "a/b", message: "m" })).toEqual({
      severity: "error",
      rule: "a/b",
      message: "m",
      file: null,
      line: null,
      subject: null,
      kind: null,
    });
  });

  it("keeps the message on one line", () => {
    const f = finding({ severity: "warning", rule: "a/b", message: "one\ntwo\r\nthree\rfour" });
    expect(f.message).toBe("one two three four");
  });
});

describe("sortFindings", () => {
  it("orders by file (nulls first), line, severity, rule, subject and message", () => {
    const f = (o: Partial<Finding>) =>
      finding({ severity: "error", rule: "r/a", message: "m", ...o });
    const sorted = [
      f({}),
      f({ file: "a", line: null }),
      f({ file: "a", line: 1, severity: "error", rule: "r/b" }),
      f({ file: "a", line: 1, severity: "warning", rule: "r/a" }),
      f({ file: "a", line: 2 }),
      f({ file: "b", subject: null }),
      f({ file: "b", subject: "x", message: "a" }),
      f({ file: "b", subject: "x", message: "b" }),
    ];
    expect(sortFindings([...sorted].reverse())).toEqual(sorted);
  });

  it("is idempotent and insensitive to input order", () => {
    fc.assert(
      fc.property(
        fc
          .array(arbFinding, { maxLength: 12 })
          .chain((fs) =>
            fc.tuple(
              fc.constant(fs),
              fc.shuffledSubarray(fs, { minLength: fs.length, maxLength: fs.length }),
            ),
          ),
        ([fs, shuffled]) => {
          const sorted = sortFindings(fs);
          expect(sortFindings(sorted)).toEqual(sorted);
          expect(sortFindings(shuffled)).toEqual(sorted);
        },
      ),
    );
  });

  it("does not mutate its input", () => {
    const fs = [
      finding({ severity: "error", rule: "b", message: "" }),
      finding({ severity: "error", rule: "a", message: "" }),
    ];
    const copy = [...fs];
    sortFindings(fs);
    expect(fs).toEqual(copy);
  });
});

describe("exitCode", () => {
  it("agrees with summarize under both failOn values", () => {
    fc.assert(
      fc.property(fc.array(arbFinding, { maxLength: 8 }), (fs) => {
        const { errors, warnings } = summarize(fs);
        expect(errors + warnings).toBe(fs.length);
        expect(exitCode(fs)).toBe(errors > 0 ? 1 : 0);
        expect(exitCode(fs, { failOn: "error" })).toBe(errors > 0 ? 1 : 0);
        expect(exitCode(fs, { failOn: "warning" })).toBe(errors + warnings > 0 ? 1 : 0);
      }),
    );
  });
});
