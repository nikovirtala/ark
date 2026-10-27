import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { MemoryTree } from "../git/tree.js";
import { MAX_CONFIG_BYTES, parseToolConfig, readToolConfig, type SourceConfig } from "./config.js";

const VALID = `
title = "decisions"

[[sources]]
name = "platform"
kind = "adr"
url = "git@github.com:acme/platform-decisions.git"
ref = "main"

[[sources]]
name = "payments"
kind = "issues"
url = "../payments"
ref = "v1.2.0"
root = "./docs/issues/"
extra = "ignored"

[mcp]
enabled = true
`;

function source(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return `[[sources]]\n${lines.join("\n")}\n`;
}

const base = { name: "platform", kind: "adr", url: "../platform.git", ref: "main" };

function configError(text: string): ConfigError {
  try {
    parseToolConfig(text, { file: "adr.toml" });
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("parseToolConfig", () => {
  it("parses sources and returns the rest of the document as raw", () => {
    const c = parseToolConfig(VALID, { file: "adr.toml" });
    expect(c.file).toBe("adr.toml");
    expect(c.sources).toEqual<SourceConfig[]>([
      {
        name: "platform",
        kind: "adr",
        url: "git@github.com:acme/platform-decisions.git",
        ref: "main",
        root: null,
      },
      { name: "payments", kind: "issues", url: "../payments", ref: "v1.2.0", root: "docs/issues" },
    ]);
    expect(c.raw).toEqual({ title: "decisions", mcp: { enabled: true } });
  });

  it("accepts a document without sources", () => {
    expect(parseToolConfig("")).toEqual({ sources: [], raw: {}, file: null });
  });

  it("accepts full 40- and 64-hex commit ids as refs", () => {
    for (const ref of ["a".repeat(40), "0123456789abcdef".repeat(4)]) {
      expect(parseToolConfig(source({ ...base, ref })).sources[0]?.ref).toBe(ref);
    }
  });

  it("reports TOML syntax errors with the line", () => {
    const e = configError("a = 1\n[[sources]]\nname =\n");
    expect(e.file).toBe("adr.toml");
    expect(e.line).toBe(3);
    expect(e.message).toMatch(/^adr\.toml: Invalid TOML document/);
    expect(e.message).not.toContain("\n");
  });

  it.each<[string, string]>([
    ['sources = "x"', "sources must be an array of tables"],
    ["sources = [1]", "sources[0] must be a table"],
    [source({ kind: "adr", url: "x", ref: "main" }), "sources[0].name is required"],
    [
      "[[sources]]\nname = 1\nkind = 'adr'\nurl = 'x'\nref = 'main'",
      "sources[0].name must be a string",
    ],
    [source({ ...base, name: "Platform" }), "sources[0].name must match"],
    [source({ ...base, name: `p${"x".repeat(32)}` }), "sources[0].name must match"],
    [source({ ...base, kind: "Adr" }), "sources[0].kind must match"],
    [source({ ...base, kind: `a${"x".repeat(64)}` }), "sources[0].kind must match"],
    [source({ ...base, url: "" }), "sources[0].url must be 1 to 2048 chars"],
    [source({ ...base, url: `/${"x".repeat(2048)}` }), "sources[0].url must be 1 to 2048 chars"],
    [source({ ...base, url: "a\tb" }), "sources[0].url must not contain control characters"],
    [source({ ...base, url: "--upload-pack=x" }), "sources[0].url must not start with -"],
    [source({ ...base, url: "ext::sh -c touch% /tmp/pwned" }), "forbidden transport"],
    [source({ ...base, url: "FD::3" }), "forbidden transport"],
    [source({ ...base, ref: "" }), "sources[0].ref must be 1 to 256 chars"],
    [source({ ...base, ref: "x".repeat(257) }), "sources[0].ref must be 1 to 256 chars"],
    [source({ ...base, ref: "my branch" }), "must not contain whitespace"],
    [source({ ...base, ref: "-x" }), "sources[0].ref must not start with -"],
    [source({ ...base, ref: "main..dev" }), "sources[0].ref must not contain .."],
    [source({ ...base, ref: "a1b2c3d4" }), "looks like an abbreviated commit id; use the full sha"],
    [source({ ...base, ref: "a".repeat(41) }), "looks like an abbreviated commit id"],
    [source({ ...base, ref: "+main" }), "sources[0].ref must not start with +"],
    ...["a:b", "ma*", "ma?n", "ma[in]", "a\\b", "main^", "HEAD~1", "@{u}", "main@{1}"].map(
      (ref): [string, string] => [
        source({ ...base, ref }),
        "sources[0].ref must not contain :, *, ?, [, \\, ^, ~ or @{",
      ],
    ),
    [source({ ...base, root: "/abs" }), "sources[0].root: layout root"],
    [source({ ...base, root: "a/../b" }), "sources[0].root: layout root"],
    [
      `${source(base)}${source({ ...base, url: "other" })}`,
      'sources[1].name "platform" is not unique',
    ],
  ])("rejects %j", (text, message) => {
    const e = configError(text);
    expect(e.message).toContain(message);
    expect(e.file).toBe("adr.toml");
  });

  it("accepts branch, full ref, tag and full sha refs", () => {
    for (const ref of ["main", "refs/heads/main", "v1.2.0", "release/2026-10", "a".repeat(40)]) {
      expect(parseToolConfig(source({ ...base, ref })).sources[0]?.ref).toBe(ref);
    }
  });

  it("rejects an oversized document", () => {
    expect(() => parseToolConfig(`# ${"x".repeat(MAX_CONFIG_BYTES)}`)).toThrow(ConfigError);
  });

  it("accepts every generated valid config", () => {
    const arbSource = fc.record({
      name: fc.stringMatching(/^[a-z][a-z0-9-]{0,31}$/),
      kind: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
      url: fc.oneof(
        fc.stringMatching(/^\.\.\/[a-z0-9._-]{1,20}$/),
        fc.stringMatching(/^https:\/\/example\.com\/[a-z0-9/._-]{1,40}$/),
      ),
      ref: fc.oneof(
        fc.stringMatching(/^[a-z][a-z0-9/_-]{0,30}$/).filter((r) => !/^[0-9a-f]{7,}$/.test(r)),
        fc.stringMatching(/^[0-9a-f]{40}$/),
      ),
      root: fc.option(fc.stringMatching(/^[a-z]{1,8}(?:\/[a-z]{1,8}){0,2}$/), { nil: null }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(arbSource, { selector: (s) => s.name, maxLength: 5 }),
        (sources) => {
          const text = sources
            .map(({ root, ...s }) => source(root === null ? s : { ...s, root }))
            .join("\n");
          expect(parseToolConfig(text).sources).toEqual(sources);
        },
      ),
    );
  });
});

describe("readToolConfig", () => {
  it("reads a config from a tree, or returns null when it's absent", async () => {
    const tree = new MemoryTree({ "adr.toml": `\uFEFF${source(base)}` });
    expect((await readToolConfig(tree, "adr.toml"))?.sources).toEqual([{ ...base, root: null }]);
    expect(await readToolConfig(tree, "issues.toml")).toBeNull();
  });

  it("rejects invalid UTF-8 and oversized files", async () => {
    const tree = new MemoryTree({
      "bad.toml": new Uint8Array([0x61, 0x3d, 0xff]),
      "big.toml": new Uint8Array(MAX_CONFIG_BYTES + 1),
    });
    await expect(readToolConfig(tree, "bad.toml")).rejects.toThrow(
      "bad.toml: config is not valid UTF-8",
    );
    await expect(readToolConfig(tree, "big.toml")).rejects.toMatchObject({
      code: "config",
      file: "big.toml",
    });
  });
});
