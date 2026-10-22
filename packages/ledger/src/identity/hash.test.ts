import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bodySha256, findDuplicates } from "./hash.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("bodySha256", () => {
  it("is the lowercase hex SHA-256 of an LF file", () => {
    expect(bodySha256(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("treats CRLF and LF alike, but keeps a lone CR", () => {
    expect(bodySha256(bytes("a\r\nb\r\n"))).toBe(bodySha256(bytes("a\nb\n")));
    expect(bodySha256(bytes("a\rb"))).not.toBe(bodySha256(bytes("ab")));
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("a", "\n", "é") }), (s) => {
        expect(bodySha256(bytes(s.replace(/\n/g, "\r\n")))).toBe(bodySha256(bytes(s)));
      }),
    );
  });
});

describe("findDuplicates", () => {
  it("keeps only keys with two or more items", () => {
    const items = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "a", n: 3 },
      { id: "c", n: 4 },
      { id: "a", n: 5 },
    ];
    expect(findDuplicates(items, (i) => i.id)).toEqual(
      new Map([
        [
          "a",
          [
            { id: "a", n: 1 },
            { id: "a", n: 3 },
            { id: "a", n: 5 },
          ],
        ],
      ]),
    );
    expect(findDuplicates([], (i: string) => i).size).toBe(0);
  });
});
