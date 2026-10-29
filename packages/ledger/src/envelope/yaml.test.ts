import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbEnvelope } from "../testing/arbitraries.js";
import { canonicalEvent, MAX_EVENT_BYTES, parseEventYaml, serializeEvent } from "./yaml.js";

const event = {
  envelope: "ledger/v1",
  kind: "decision",
  schema: "decision/v1",
  id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
  subject: "a7c2m9xd",
  type: "accepted",
  at: "2026-03-14T12:02:11Z",
  actor: { kind: "human", name: "Ada" },
  data: { body_sha256: "ab", number: "01234567" },
} as const;

const parse = (src: string | Uint8Array) => parseEventYaml(src, { file: "e.yaml" });

function unparseable(src: string | Uint8Array) {
  const r = parse(src);
  if (r.ok) throw new Error("expected a parse failure");
  return r.finding;
}

describe("serializeEvent and parseEventYaml", () => {
  it("round-trip every generated envelope to its canonical form", () => {
    fc.assert(
      fc.property(arbEnvelope(), (e) => {
        expect(parseEventYaml(serializeEvent(e), { file: null })).toEqual({
          ok: true,
          doc: canonicalEvent(e),
        });
      }),
      { numRuns: 200 },
    );
  });

  it("serialize canonical forms identically, and canonicalEvent is idempotent", () => {
    fc.assert(
      fc.property(arbEnvelope(), (e) => {
        const c = canonicalEvent(e);
        expect(canonicalEvent(c)).toEqual(c);
        expect(serializeEvent(c)).toBe(serializeEvent(e));
      }),
      { numRuns: 200 },
    );
  });

  it("write known keys in order, absent actor fields as null, and omit an absent reason", () => {
    const { data, ...rest } = event;
    const shuffled = { data, extra: 1, ...rest, actor: { x: 1, name: "Ada", kind: "human" } };
    expect(serializeEvent(shuffled)).toBe(
      [
        "envelope: ledger/v1",
        "kind: decision",
        "schema: decision/v1",
        "id: 01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
        "subject: a7c2m9xd",
        "type: accepted",
        "at: 2026-03-14T12:02:11Z",
        "actor:",
        "  kind: human",
        "  name: Ada",
        "  email: null",
        "  agent: null",
        "  on_behalf_of: null",
        "  x: 1",
        "data:",
        "  body_sha256: ab",
        '  number: "01234567"',
        "extra: 1",
        "",
      ].join("\n"),
    );
  });

  it("write an explicit null reason and a multi-line reason as a block", () => {
    expect(serializeEvent({ ...event, reason: null })).toContain("\nreason: null\ndata:");
    const text = serializeEvent({ ...event, reason: "first\nsecond" });
    expect(text).toContain("reason: |-\n  first\n  second\n");
    expect(parse(text)).toMatchObject({ ok: true, doc: { reason: "first\nsecond" } });
  });

  // Each form is the one `biome format` leaves as it is (biome 2.6.2).
  it.each([
    ["double quotes", 'see "Notes"', 'see "Notes"'],
    ["double quotes that need quoting", 'see: "Notes"', `'see: "Notes"'`],
    ["single quotes that need quoting", "it's: done", `"it's: done"`],
    ["both quotes", `it's "both"`, `it's "both"`],
    ["both quotes that need quoting", `it's: "both"`, `'it''s: "both"'`],
    ["both quotes at the edges", `"it's"`, `'"it''s"'`],
    ["both quotes and another escape", `a "b"\u0001 'c'`, `"a \\"b\\"\\x01 'c'"`],
    ["both quotes on several lines", `one "a"\ntwo 'b'`, `|-\n  one "a"\n  two 'b'`],
    ["an empty first line", "\nfirst", '"\\nfirst"'],
    ["a line of only spaces", " \n", '"\\ \\n"'],
    ["a line of only a tab", "a\n\t\nb", '"a\\n\\t\\nb"'],
    ["two trailing newlines", "x\n\n", '"x\\n\\n"'],
    ["a trailing no-break space", "a\u00a0", '"a\u00a0"'],
    ["double quotes and a trailing no-break space", '"a"\u00a0', `'"a"\u00a0'`],
    ["a byte order mark", "a\uFEFFb", '"a\\uFEFFb"'],
  ])("write a string with %s as biome formats it", (_, reason, yaml) => {
    const text = serializeEvent({ ...event, reason, data: { [reason]: reason } });
    expect(text).toContain(`\nreason: ${yaml}\ndata:\n`);
    expect(parse(text)).toMatchObject({ ok: true, doc: { reason, data: { [reason]: reason } } });
  });

  it("leave a non-mapping actor alone", () => {
    expect(canonicalEvent({ actor: "x", kind: "k" })).toEqual({ kind: "k", actor: "x" });
  });
});

describe("parseEventYaml", () => {
  it("strips a BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a: 1\n")]);
    expect(parse(bytes)).toEqual({ ok: true, doc: { a: 1 } });
    expect(parse("\uFEFFa: 1\n")).toEqual({ ok: true, doc: { a: 1 } });
  });

  it("keeps timestamps and ambiguous scalars as YAML 1.2 core reads them", () => {
    expect(parse("at: 2026-10-22T10:15:00Z\nb: yes\nc: ~\n")).toEqual({
      ok: true,
      doc: { at: "2026-10-22T10:15:00Z", b: "yes", c: null },
    });
  });

  it("rejects aliases with the alias line instead of throwing", () => {
    expect(unparseable("a: &x 1\nb: *x\n")).toMatchObject({
      rule: "event/unparseable",
      line: 2,
      file: "e.yaml",
    });
    expect(unparseable("base: &b { a: 1 }\nc:\n  <<: *b\n")).toMatchObject({
      rule: "event/unparseable",
      line: 3,
    });
  });

  it("rejects duplicate keys with their line", () => {
    expect(unparseable("a: 1\nb: 2\na: 3\n")).toEqual({
      severity: "error",
      rule: "event/unparseable",
      message: "invalid YAML: Map keys must be unique",
      file: "e.yaml",
      line: 3,
      subject: null,
      kind: null,
    });
  });

  it("rejects multiple documents", () => {
    expect(unparseable("a: 1\n---\nb: 2\n")).toMatchObject({
      rule: "event/unparseable",
      line: 2,
    });
  });

  it("rejects syntax errors", () => {
    expect(unparseable("a: [\n").rule).toBe("event/unparseable");
    expect(unparseable("x: 1\n\tb: 2\n").rule).toBe("event/unparseable");
  });

  it("rejects invalid UTF-8", () => {
    expect(unparseable(new Uint8Array([0x61, 0x3a, 0x20, 0xff, 0x0a]))).toMatchObject({
      rule: "event/unparseable",
      message: "event file is not valid UTF-8",
      line: null,
    });
  });

  it("rejects oversized files without parsing them", () => {
    const big = `a: "${"x".repeat(MAX_EVENT_BYTES)}"\n`;
    expect(unparseable(big).rule).toBe("event/too-large");
    expect(unparseable(new TextEncoder().encode(big)).rule).toBe("event/too-large");
    expect(parse(`a: ${"x".repeat(MAX_EVENT_BYTES - 4)}`).ok).toBe(true);
  });

  it("reports documents that aren't mappings", () => {
    for (const src of ["", "# only a comment\n", "- a\n", "just text\n", "null\n"]) {
      expect(unparseable(src).rule).toBe("event/not-a-mapping");
    }
  });
});
