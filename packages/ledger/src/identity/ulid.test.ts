import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError, LedgerError } from "../errors.js";
import { createUlidFactory, isUlid, ulid, ulidTime } from "./ulid.js";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

describe("ulid", () => {
  it("encodes the time like the reference implementation", () => {
    const id = createUlidFactory({ now: () => 1469918176385, random: (b) => b.fill(0) })();
    expect(id).toBe("01ARYZ6S410000000000000000");
    expect(ulidTime(id)).toBe(1469918176385);
  });

  it("matches the pattern and decodes to the clock", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 1 }), (t) => {
        const id = createUlidFactory({ now: () => t })();
        expect(id).toMatch(ULID);
        expect(isUlid(id)).toBe(true);
        expect(ulidTime(id)).toBe(t);
      }),
    );
    expect(ulid()).toMatch(ULID);
    expect(Math.abs(ulidTime(ulid()) - Date.now())).toBeLessThan(5_000);
  });

  it("sorts in generation order under a fixed or backwards clock", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1_000_000, max: 1_000_005 }), { minLength: 2, maxLength: 50 }),
        (times) => {
          let i = 0;
          const next = createUlidFactory({ now: () => times[i++] ?? 0 });
          const ids = times.map(() => next());
          expect([...ids].sort()).toEqual(ids);
          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
    );
  });

  it("draws fresh randomness per id when not monotonic", () => {
    let calls = 0;
    const next = createUlidFactory({
      now: () => 0,
      monotonic: false,
      random: (b) => {
        calls++;
        b.fill(calls);
      },
    });
    next();
    next();
    expect(calls).toBe(2);
  });

  it("throws ulid-overflow when the random part is exhausted within a millisecond", () => {
    const next = createUlidFactory({ now: () => 5, random: (b) => b.fill(255) });
    expect(next()).toBe("0000000005ZZZZZZZZZZZZZZZZ");
    const error = (() => {
      try {
        next();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(LedgerError);
    expect(error).toMatchObject({ code: "ulid-overflow" });
  });

  it("rejects bad clocks and non-ULIDs", () => {
    expect(() => createUlidFactory({ now: () => -1 })()).toThrow(InvalidArgumentError);
    expect(() => createUlidFactory({ now: () => 2 ** 48 })()).toThrow(InvalidArgumentError);
    expect(() => createUlidFactory({ now: () => 1.5 })()).toThrow(InvalidArgumentError);
    for (const s of [
      "8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
      "01arez6s410000000000000000",
      "01ARYZ6S41",
      42,
    ]) {
      expect(isUlid(s)).toBe(false);
    }
    expect(() => ulidTime("nope")).toThrow(InvalidArgumentError);
  });
});
