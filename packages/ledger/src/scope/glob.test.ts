import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { escapeGlob, type GlobProblem, globMatcher, MAX_GLOB_LENGTH, parseGlob } from "./glob.js";

function glob(source: string) {
  const r = parseGlob(source);
  if (!r.ok) throw new Error(r.message);
  return r.glob;
}

const problemOf = (source: string) => {
  const r = parseGlob(source);
  return r.ok ? null : r.problem;
};

describe("parseGlob", () => {
  it.each<[string, GlobProblem]>([
    ["", "empty"],
    ["a".repeat(MAX_GLOB_LENGTH + 1), "too-long"],
    ["a\tb", "control-char"],
    ["a\u007fb", "control-char"],
    ["/a", "absolute"],
    ["!a", "negation"],
    ["./a", "dot-segment"],
    ["a/../b", "dot-segment"],
    ["\\.", "dot-segment"],
    [".\\.", "dot-segment"],
    ["\\.\\.", "dot-segment"],
    ["a/\\.\\./b", "dot-segment"],
    ["a//b", "empty-segment"],
    ["a/", "trailing-slash"],
    ["{}", "brace-content"],
    ["{**,x}", "brace-content"],
    ["a{**}", "brace-content"],
    ["a**", "globstar"],
    ["***", "globstar"],
    ["{a}**", "globstar"],
    ["{src/a,lib}", "unbalanced"],
    ["}a", "unbalanced"],
    ["{a,b", "unbalanced"],
    ["[ab", "unbalanced"],
    ["[a/b]", "unbalanced"],
    ["[!]", "unbalanced"],
    ["[a\\", "unbalanced"],
    ["{a,{b}}", "nested-braces"],
    ["{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}", "too-many-alternatives"],
    ["a\\", "trailing-escape"],
  ])("rejects %j as %s", (source, problem) => {
    expect(problemOf(source)).toBe(problem);
  });

  it("reports the first problem in phase order", () => {
    expect(problemOf("/a/")).toBe("absolute");
    expect(problemOf("!a**")).toBe("negation");
    expect(problemOf("./a//b/")).toBe("dot-segment");
    expect(problemOf("a//b/")).toBe("empty-segment");
    expect(problemOf("a**/{}")).toBe("brace-content");
    expect(problemOf("a**/}")).toBe("unbalanced");
    expect(problemOf("a**\\")).toBe("globstar");
    expect(problemOf("{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}\\")).toBe("too-many-alternatives");
  });

  it("explains a problem in its message", () => {
    expect(parseGlob("!a")).toEqual({
      ok: false,
      problem: "negation",
      message: `invalid glob "!a": negated globs aren't supported; remove the glob instead`,
    });
    expect(parseGlob("{}")).toMatchObject({
      message: `invalid glob "{}": a brace group needs at least one character and can't contain **`,
    });
  });

  it.each([
    "{a}",
    "{a,}",
    "{,}",
    "x{a\\,b,c}",
    "{[ab],c}",
    "[{]",
    "[}]",
    "[\\]]",
    "[]a]",
    "\\!x",
    "x!",
    "{.}",
    "src/*{*}",
    "{.,a}/x",
    "{,a}/x",
    "(a|b)+@",
    "\\**",
    "a/**/**",
    "{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}",
  ])("accepts %j", (source) => {
    expect(parseGlob(source).ok).toBe(true);
  });

  it("escapes the next character everywhere", () => {
    expect(glob("x{a\\,b,c}").matches("xa,b")).toBe(true);
    expect(glob("x{a\\,b,c}").matches("xc")).toBe(true);
    expect(glob("x{a\\,b,c}").matches("xa")).toBe(false);
    expect(glob("[\\]\\-]").matches("]")).toBe(true);
    expect(glob("[\\]\\-]").matches("-")).toBe(true);
    expect(glob("[\\]\\-]").matches("a")).toBe(false);
    expect(glob("\\*").matches("*")).toBe(true);
    expect(glob("\\*").matches("a")).toBe(false);
    expect(glob("\\!x").matches("!x")).toBe(true);
    expect(glob("a\\/b").matches("a/b")).toBe(false);
  });

  it("reads classes", () => {
    expect(glob("[{]").matches("{")).toBe(true);
    expect(glob("[}]").matches("}")).toBe(true);
    expect(glob("[]a]").matches("]")).toBe(true);
    expect(glob("[]a]").matches("a")).toBe(true);
    expect(glob("[]a]").matches("b")).toBe(false);
    expect(glob("[a-c]x").matches("bx")).toBe(true);
    expect(glob("[a-c]x").matches("dx")).toBe(false);
    expect(glob("[-a]").matches("-")).toBe(true);
    expect(glob("[!a]").matches("b")).toBe(true);
    expect(glob("[!a]").matches("a")).toBe(false);
    expect(glob("[^a]").matches("a")).toBe(false);
    expect(glob("{[ab],c}").matches("b")).toBe(true);
    expect(glob("{[ab],c}").matches("c")).toBe(true);
    expect(glob("{[ab],c}").matches("d")).toBe(false);
  });

  it("matches ? and * within one segment, dot-files included", () => {
    expect(glob("a?c").matches("abc")).toBe(true);
    expect(glob("a?c").matches("ac")).toBe(false);
    expect(glob("a?c").matches("a/c")).toBe(false);
    expect(glob("src/*").matches("src/.env")).toBe(true);
    expect(glob("src/*").matches("src/a/b")).toBe(false);
    expect(glob("*.md").matches("a.md")).toBe(true);
    expect(glob("*.md").matches("d/a.md")).toBe(false);
  });

  it("matches ** as a whole segment", () => {
    const src = glob("src/**");
    expect(src.matches("src")).toBe(false);
    expect(src.matches("src/a")).toBe(true);
    expect(src.matches("src/a/b")).toBe(true);
    expect(src.matches("src/.env")).toBe(true);
    expect(glob("**").matches("a")).toBe(true);
    expect(glob("**").matches(".github/x.yml")).toBe(true);
    expect(glob("**/*.yml").matches(".github/x.yml")).toBe(true);
    expect(glob("**/x.ts").matches("x.ts")).toBe(true);
    expect(glob("**/x.ts").matches("a/b/x.ts")).toBe(true);
    expect(glob("a/**/b").matches("a/b")).toBe(true);
    expect(glob("a/**/b").matches("a/x/y/b")).toBe(true);
    expect(glob("a/**/b").matches("a/x/c")).toBe(false);
    expect(glob("a/**/**").matches("a/b")).toBe(true);
    expect(glob("a/**/**").matches("a")).toBe(false);
  });

  it("expands braces as tokens", () => {
    expect(glob("src/*{*}").matches("src/a")).toBe(true);
    expect(glob("src/*{*}").matches("src/a/b")).toBe(false);
    for (const g of ["{.,a}/x", "{,a}/x"]) {
      expect(glob(g).matches("a/x")).toBe(true);
      expect(glob(g).matches("x")).toBe(false);
      expect(glob(g).matches("b/x")).toBe(false);
    }
    expect(glob("{a,}x").matches("ax")).toBe(true);
    expect(glob("{a,}x").matches("x")).toBe(true);
    expect(glob("{.}").matches("a")).toBe(false);
  });

  it("never matches paths git can't track", () => {
    for (const p of ["", "/a", "a/", "a//b", "./a", "a/../b"]) {
      expect(glob("**").matches(p)).toBe(false);
    }
  });

  it("describes literal, prefix and segments", () => {
    const g = glob("src/a\\[1\\]/**");
    expect(g.literal).toBeNull();
    expect(g.prefix).toBe("src/a[1]");
    expect(g.prefixSegments).toBe(2);
    expect(g.segments).toEqual(["src", "a\\[1\\]", "**"]);
    expect(glob("docs/x.md")).toMatchObject({
      literal: "docs/x.md",
      prefix: "docs/x.md",
      prefixSegments: 2,
    });
    expect(glob("*.md")).toMatchObject({ literal: null, prefix: "", prefixSegments: 0 });
    expect(glob("a/{b,c}/d")).toMatchObject({ literal: null, prefix: "a", prefixSegments: 1 });
    expect(glob("a\\/b").segments).toEqual(["a\\/b"]);
  });
});

describe("escapeGlob", () => {
  it("escapes every special character and a leading !", () => {
    expect(escapeGlob("!notes.md")).toBe("\\!notes.md");
    expect(escapeGlob("a!b")).toBe("a!b");
    expect(escapeGlob("a*b?[c]{d}\\e")).toBe("a\\*b\\?\\[c\\]\\{d\\}\\\\e");
    expect(glob(escapeGlob("!notes.md")).literal).toBe("!notes.md");
    expect(glob(escapeGlob("src/a[1]/{x}.ts")).matches("src/a[1]/{x}.ts")).toBe(true);
  });

  it("can't express overlong paths or control characters", () => {
    expect(parseGlob(escapeGlob("a".repeat(501))).ok).toBe(false);
    expect(parseGlob(escapeGlob("a\tb")).ok).toBe(false);
  });

  it("round-trips every path whose escaped form parses", () => {
    const unit = fc.constantFrom("a", "/", "!", "*", "?", "\\", "[", "]", "{", "}", ".", ",", "é");
    fc.assert(
      fc.property(fc.string({ unit, minLength: 1, maxLength: 12 }), (p) => {
        const r = parseGlob(escapeGlob(p));
        if (!r.ok) return;
        expect(r.glob.literal).toBe(p);
        expect(r.glob.prefix).toBe(p);
        expect(r.glob.matches(p)).toBe(true);
      }),
    );
  });
});

describe("globMatcher", () => {
  it("returns the matching globs in input order and skips invalid ones", () => {
    const m = globMatcher(["src/**", "src/", "*.md", "src/a.ts", "!src/a.ts"]);
    expect(m("src/a.ts")).toEqual(["src/**", "src/a.ts"]);
    expect(m("README.md")).toEqual(["*.md"]);
    expect(m("lib/x")).toEqual([]);
  });
});

// The reference: globs as data, rendered to source, and matched by plain backtracking.
type RToken =
  | { readonly t: "lit"; readonly c: string }
  | { readonly t: "one" }
  | { readonly t: "star" }
  | { readonly t: "class"; readonly neg: boolean; readonly items: readonly string[] };
type RPart = RToken | { readonly t: "group"; readonly alts: readonly (readonly RToken[])[] };
type RSeg = "**" | readonly RPart[];

const LIT = ["a", "b", ".", "*", ","] as const;
const PATH_CHARS = ["a", "b", ".", "*", ","] as const;

function renderToken(x: RToken, inGroup: boolean): string {
  switch (x.t) {
    case "lit":
      return x.c === "*" || (inGroup && x.c === ",") ? `\\${x.c}` : x.c;
    case "one":
      return "?";
    case "star":
      return "*";
    case "class":
      return `[${x.neg ? "!" : ""}${x.items.join("")}]`;
  }
}

const renderSeg = (s: RSeg) =>
  s === "**"
    ? "**"
    : s
        .map((p) =>
          p.t === "group"
            ? `{${p.alts.map((a) => a.map((x) => renderToken(x, true)).join("")).join(",")}}`
            : renderToken(p, false),
        )
        .join("");

/** No two `*` next to each other, which would form a `**` that isn't a whole segment. */
const noAdjacentStars = (xs: readonly { readonly t: string }[]) =>
  xs.every((x, i) => i === 0 || x.t !== "star" || xs[i - 1]?.t !== "star");

const arbToken: fc.Arbitrary<RToken> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...LIT).map((c) => ({ t: "lit" as const, c })) },
  { weight: 1, arbitrary: fc.constant({ t: "one" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "star" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("class" as const),
      neg: fc.boolean(),
      items: fc.array(fc.constantFrom("a", "b", ".", "a-b"), { minLength: 1, maxLength: 2 }),
    }),
  },
);

const arbAlt = fc.array(arbToken, { maxLength: 3 }).filter(noAdjacentStars);
const arbGroup = fc
  .array(arbAlt, { minLength: 1, maxLength: 3 })
  .filter((alts) => alts.length > 1 || (alts[0]?.length ?? 0) > 0)
  .map((alts) => ({ t: "group" as const, alts }));
const arbPart: fc.Arbitrary<RPart> = fc.oneof(
  { weight: 4, arbitrary: arbToken },
  { weight: 1, arbitrary: arbGroup },
);
const arbSeg: fc.Arbitrary<RSeg> = fc.oneof(
  { weight: 1, arbitrary: fc.constant("**" as const) },
  {
    weight: 4,
    arbitrary: fc
      .array(arbPart, { minLength: 1, maxLength: 4 })
      .filter(noAdjacentStars)
      .filter((ps) => {
        const text = renderSeg(ps).replaceAll("\\", "");
        return text !== "." && text !== "..";
      }),
  },
);
const alternativesOf = (segs: readonly RSeg[]) =>
  segs.reduce(
    (n, s) => (s === "**" ? n : s.reduce((m, p) => (p.t === "group" ? m * p.alts.length : m), n)),
    1,
  );
const arbGlob = fc
  .array(arbSeg, { minLength: 1, maxLength: 3 })
  .filter((segs) => alternativesOf(segs) <= 64);

const arbPath = fc
  .array(
    fc
      .array(fc.constantFrom(...PATH_CHARS), { minLength: 1, maxLength: 3 })
      .map((cs) => cs.join(""))
      .filter((s) => s !== "." && s !== ".."),
    { minLength: 1, maxLength: 4 },
  )
  .map((segs) => segs.join("/"));

function refExpand(parts: readonly RPart[]): RToken[][] {
  let out: RToken[][] = [[]];
  for (const p of parts) {
    out =
      p.t === "group"
        ? out.flatMap((s) => p.alts.map((a) => [...s, ...a]))
        : out.map((s) => [...s, p]);
  }
  return out;
}

function refChar(x: RToken, c: string): boolean {
  if (x.t === "lit") return x.c === c;
  if (x.t === "one") return true;
  if (x.t === "star") return false;
  const hit = x.items.some((it) =>
    it.length === 3 ? (it[0] as string) <= c && c <= (it[2] as string) : it === c,
  );
  return hit !== x.neg;
}

function refTokens(xs: readonly RToken[], s: string, i: number, j: number): boolean {
  if (i === xs.length) return j === s.length;
  const x = xs[i] as RToken;
  if (x.t === "star") {
    for (let k = j; k <= s.length; k++) if (refTokens(xs, s, i + 1, k)) return true;
    return false;
  }
  return j < s.length && refChar(x, s[j] as string) && refTokens(xs, s, i + 1, j + 1);
}

function refSegment(xs: readonly RToken[], s: string): boolean {
  const dots = xs.length <= 2 && xs.every((x) => x.t === "lit" && x.c === ".");
  return xs.length > 0 && !dots && refTokens(xs, s, 0, 0);
}

function refMatch(segs: readonly RSeg[], path: readonly string[], i = 0, j = 0): boolean {
  if (i === segs.length) return j === path.length;
  const g = segs[i] as RSeg;
  if (g === "**") {
    const min = i === segs.length - 1 ? 1 : 0;
    for (let k = j + min; k <= path.length; k++) if (refMatch(segs, path, i + 1, k)) return true;
    return false;
  }
  return (
    j < path.length &&
    refExpand(g).some((xs) => refSegment(xs, path[j] as string)) &&
    refMatch(segs, path, i + 1, j + 1)
  );
}

describe("glob matching", () => {
  it("agrees with a reference matcher on generated globs and paths", () => {
    fc.assert(
      fc.property(arbGlob, fc.array(arbPath, { minLength: 1, maxLength: 8 }), (segs, paths) => {
        const source = segs.map(renderSeg).join("/");
        const g = glob(source);
        expect(g.segments.join("/")).toBe(source);
        for (const p of paths) {
          expect(g.matches(p), `${source} vs ${p}`).toBe(refMatch(segs, p.split("/")));
        }
      }),
      { numRuns: 300 },
    );
  });
});
