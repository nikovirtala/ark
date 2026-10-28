import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { countOccurrences, foldText, searchExcerpt, searchTerms } from "./text-search.js";

describe("foldText", () => {
  it.each([
    ["Café", "cafe"],
    ["ﬁle", "file"],
    ["STRASSE", "strasse"],
    ["Straße", "straße"],
    ["ẞ", "ß"],
    ["Ørsted", "ørsted"],
    ["İstanbul", "istanbul"],
  ])("%s → %s", (s, f) => {
    expect(foldText(s).text).toBe(f);
  });

  it("maps every folded offset back to the original", () => {
    const f = foldText("ﬁ Café");
    expect(f.text).toBe("fi cafe");
    expect(f.at).toEqual([0, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("maps offsets into the original for any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), (s) => {
        const { text, at } = foldText(s);
        expect(at).toHaveLength(text.length + 1);
        expect(at[0]).toBe(0);
        expect(at.at(-1)).toBe(s.length);
        for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1] ?? 0);
      }),
    );
  });
});

describe("searchTerms", () => {
  it("folds, splits on whitespace and dedupes, keeping query order", () => {
    expect(searchTerms("  Café  login\u00a0CAFE café ")).toEqual(["cafe", "login"]);
  });

  it("accepts exactly 200 characters and 10 terms", () => {
    expect(searchTerms("a".repeat(200))).toEqual(["a".repeat(200)]);
    const ten = Array.from({ length: 10 }, (_, i) => `w${i}`);
    expect(searchTerms(ten.join(" "))).toEqual(ten);
  });

  it.each([
    ["", "the search query must be 1 to 200 characters without control characters"],
    ["   ", "the search query must be 1 to 200 characters without control characters"],
    ["a".repeat(201), "the search query must be 1 to 200 characters without control characters"],
    ["a\u0000b", "the search query must be 1 to 200 characters without control characters"],
    ["a\u007fb", "the search query must be 1 to 200 characters without control characters"],
    [Array.from({ length: 11 }, (_, i) => `w${i}`).join(" "), "a search takes at most 10 words"],
    ["\u0301", "the search query must contain a letter, digit or symbol"],
  ])("refuses %j", (q, message) => {
    expect(() => searchTerms(q)).toThrow(new UsageError(message));
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping hits", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abcabc", "bc")).toBe(2);
    expect(countOccurrences("abc", "x")).toBe(0);
  });
});

describe("searchExcerpt", () => {
  it("returns a short line whole, whitespace collapsed", () => {
    expect(searchExcerpt(["  the   Café  is open "], ["cafe"])).toBe("the Café is open");
  });

  it("takes the first line with the most distinct terms", () => {
    expect(
      searchExcerpt(["one cafe", "two cafe", "cafe login", "login cafe"], ["cafe", "login"]),
    ).toBe("cafe login");
    expect(searchExcerpt(["first cafe", "second cafe"], ["cafe"])).toBe("first cafe");
  });

  it("returns null when no line has a hit", () => {
    expect(searchExcerpt(["nothing here"], ["cafe"])).toBeNull();
    expect(searchExcerpt([], ["cafe"])).toBeNull();
  });

  it("windows a long line around the first hit at word boundaries", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(2, "0")}`);
    words[30] = "Café";
    const line = words.join(" ");
    const e = searchExcerpt([line], ["cafe"]);
    expect(e).not.toBeNull();
    expect(e?.startsWith("…word")).toBe(true);
    expect(e?.endsWith("…")).toBe(true);
    expect(e).toContain("Café");
    const inner = e?.slice(1, -1) ?? "";
    expect(line).toContain(inner);
    expect(inner.length).toBeLessThanOrEqual(160);
    expect(line[line.indexOf(inner) - 1]).toBe(" ");
    expect(line[line.indexOf(inner) + inner.length]).toBe(" ");
  });

  it("cuts only the end when the hit is near the start", () => {
    const line = `Café ${"x".repeat(10)} ${"y ".repeat(100)}`.trim();
    const e = searchExcerpt([line], ["cafe"]);
    expect(e?.startsWith("Café")).toBe(true);
    expect(e?.endsWith("…")).toBe(true);
  });

  it("cuts only the start when the hit is near the end", () => {
    const line = `${"y ".repeat(100)}Café`;
    const e = searchExcerpt([line], ["cafe"]);
    expect(e?.startsWith("…")).toBe(true);
    expect(e?.endsWith("Café")).toBe(true);
  });
});
