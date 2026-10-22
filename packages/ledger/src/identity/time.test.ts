import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { atToStamp, formatAt, isAt } from "./time.js";

describe("event times", () => {
  it("formats UTC to seconds, truncating milliseconds", () => {
    expect(formatAt(new Date("2026-10-22T10:15:00.999Z"))).toBe("2026-10-22T10:15:00Z");
    expect(formatAt(0)).toBe("1970-01-01T00:00:00Z");
    expect(() => formatAt(new Date("nope"))).toThrow(InvalidArgumentError);
    expect(() => formatAt(Date.UTC(10000, 0, 1))).toThrow(InvalidArgumentError);
  });

  it("accepts only real calendar dates in the exact pattern", () => {
    for (const ok of ["2026-10-22T10:15:00Z", "2024-02-29T23:59:59Z", "0001-01-01T00:00:00Z"]) {
      expect(isAt(ok)).toBe(true);
    }
    for (const bad of [
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-10-22T24:00:00Z",
      "2026-10-22T10:60:00Z",
      "2026-10-22T10:15:60Z",
      "2026-10-22T10:15:00.000Z",
      "2026-10-22T10:15:00z",
      "2026-10-22T10:15:00+00:00",
      "2026-10-22 10:15:00Z",
      20261022,
    ]) {
      expect(isAt(bad)).toBe(false);
    }
  });

  it("round-trips through Date", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(0), max: new Date("9999-12-31T23:59:59Z"), noInvalidDate: true }),
        (d) => {
          const at = formatAt(d);
          expect(isAt(at)).toBe(true);
          expect(formatAt(new Date(at))).toBe(at);
          expect(new Date(at).getTime()).toBe(Math.floor(d.getTime() / 1000) * 1000);
        },
      ),
    );
  });

  it("converts to a file-name stamp", () => {
    expect(atToStamp("2026-10-22T10:15:00Z")).toBe("20261022T101500Z");
    expect(() => atToStamp("2026-02-30T00:00:00Z")).toThrow(InvalidArgumentError);
  });
});
