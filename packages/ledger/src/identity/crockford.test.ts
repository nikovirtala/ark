import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { CROCKFORD, decodeCrockford, encodeCrockford } from "./crockford.js";

describe("Crockford base32", () => {
  it("uses the 32-char alphabet without I, L, O and U", () => {
    expect(CROCKFORD).toHaveLength(32);
    expect(new Set(CROCKFORD).size).toBe(32);
    expect(CROCKFORD).not.toMatch(/[ILOU]/);
  });

  it("encodes big-endian into exactly the requested width", () => {
    expect(encodeCrockford(new Uint8Array([0, 0, 0, 0, 0]), 8)).toBe("00000000");
    expect(encodeCrockford(new Uint8Array([255, 255, 255, 255, 255]), 8)).toBe("ZZZZZZZZ");
    expect(encodeCrockford(new Uint8Array([1]), 4)).toBe("0001");
    expect(encodeCrockford(new Uint8Array([0x20]), 2)).toBe("10");
  });

  it("round-trips bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 20 }), (bytes) => {
        const chars = Math.ceil((bytes.length * 8) / 5);
        const s = encodeCrockford(bytes, chars);
        expect(s).toHaveLength(chars);
        expect(decodeCrockford(s)).toEqual(bytes);
        expect(decodeCrockford(s.toLowerCase())).toEqual(bytes);
      }),
    );
  });

  it("rejects overflow and invalid characters", () => {
    expect(() => encodeCrockford(new Uint8Array([255, 255]), 3)).toThrow(InvalidArgumentError);
    expect(() => decodeCrockford("0I")).toThrow(InvalidArgumentError);
    expect(() => decodeCrockford("ZZ")).toThrow(InvalidArgumentError);
  });
});
