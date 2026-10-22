import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.js";
import { parseTemplate, type Template } from "./parse.js";
import { extractSections, normalizeSection, renderTemplate } from "./render.js";

function template(text: string): Template {
  const r = parseTemplate(text);
  if (!r.ok || r.findings.length > 0) {
    throw new Error(`expected a clean template: ${JSON.stringify(r.findings)}`);
  }
  return r.template;
}

const ADR = template(`---
template: adr
version: 1
sections:
  - id: context
    heading: Context
    required: true
    guidance: What forces led here?
  - id: decision
    heading: Decision
    required: true
  - id: notes
    heading: Notes
---
# {{title}}

Intro text.

## Context
{{context}}

### Decision
{{decision}}

## Notes
{{notes}}
`);

function rendered(t: Template, input: Parameters<typeof renderTemplate>[1], o = {}): string {
  const r = renderTemplate(t, input, o);
  if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r.findings)}`);
  return r.text;
}

const mapValues = (m: Record<string, string>, f: (v: string) => string) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, f(v)]));

/** Lint-clean templates with 1–5 sections at heading levels 2–3, with or without intro text. */
const arbTemplate: fc.Arbitrary<Template> = fc
  .uniqueArray(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/).filter((id) => id !== "title"),
    { minLength: 1, maxLength: 5 },
  )
  .chain((ids) =>
    fc.tuple(
      fc.constant(ids),
      fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
      fc.array(fc.constantFrom("##", "###"), { minLength: ids.length, maxLength: ids.length }),
      fc.boolean(),
    ),
  )
  .map(([ids, required, levels, intro]) => {
    const fm = [
      "---",
      "template: gen",
      "version: 1",
      "sections:",
      ...ids.flatMap((id, i) => [
        `  - id: "${id}"`,
        `    heading: Heading ${i}`,
        `    required: ${required[i]}`,
        `    guidance: Guidance for ${id}.`,
      ]),
      "---",
    ];
    const body = [
      "# {{title}}",
      ...(intro ? ["", "Some intro text."] : []),
      ...ids.flatMap((id, i) => ["", `${levels[i]} Heading ${i}`, `{{${id}}}`]),
      "",
    ];
    return template([...fm, ...body].join("\n"));
  });

const arbLine = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("{{x}}"),
  fc.constant("    indented code"),
  fc.constant("trailing spaces   "),
  fc.stringMatching(/^ {0,4}[A-Za-z0-9#*`.{}-][A-Za-z0-9 #*`.{}-]{0,20}$/),
);

/** Multi-line section text, never containing one of the template's heading lines. */
function arbContent(t: Template): fc.Arbitrary<string> {
  const headings = new Set(
    t.body.split("\n").filter((l) => /^#{2,3} Heading \d$/.test(l) || l === "## Context"),
  );
  return fc
    .tuple(fc.array(arbLine, { maxLength: 6 }), fc.constantFrom("\n", "\r\n"))
    .map(([lines, sep]) => lines.join(sep))
    .filter(
      (c) =>
        !normalizeSection(c)
          .split("\n")
          .some((l) => headings.has(l)),
    );
}

const arbTitle = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .:{}-]{0,30}$/).map((s) => s.trim());

const arbCase = arbTemplate.chain((t) =>
  fc.record({
    t: fc.constant(t),
    title: arbTitle,
    sections: fc.record(Object.fromEntries(t.sections.map((s) => [s.id, arbContent(t)]))),
  }),
);

describe("normalizeSection", () => {
  it("normalizes line endings, trailing whitespace and surrounding blank lines", () => {
    expect(normalizeSection("\r\n  \n  code  \r\ntext\t\n\n \n")).toBe("  code\ntext");
    expect(normalizeSection(" \n\t")).toBe("");
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeSection(s);
        expect(normalizeSection(once)).toBe(once);
      }),
    );
  });
});

describe("renderTemplate", () => {
  it("fills the title and each section's placeholder line", () => {
    const text = rendered(ADR, {
      title: "  Use DynamoDB  ",
      sections: { context: "\nOrders need low latency.  \n\n", decision: "We will." },
    });
    expect(text).toBe(
      "# Use DynamoDB\n\nIntro text.\n\n## Context\nOrders need low latency.\n\n### Decision\nWe will.\n\n## Notes\n\n",
    );
  });

  it("fills missing sections with guidance on request", () => {
    const text = rendered(ADR, { title: "T", sections: {} }, { missing: "guidance" });
    expect(extractSections(ADR, text).sections).toEqual({
      context: "What forces led here?",
      decision: "",
      notes: "",
    });
  });

  it("never re-scans substituted text", () => {
    const text = rendered(ADR, {
      title: "{{context}}",
      sections: { context: "{{decision}}", decision: "{{title}}" },
    });
    expect(extractSections(ADR, text)).toMatchObject({
      title: "{{context}}",
      sections: { context: "{{decision}}", decision: "{{title}}", notes: "" },
    });
  });

  it("keeps content that starts with an indented code block", () => {
    const context = "    const x = 1;\n    return x;\n\nThen prose.";
    const text = rendered(ADR, { title: "T", sections: { context } });
    expect(extractSections(ADR, text).sections.context).toBe(context);
  });

  it.each<[string, Parameters<typeof renderTemplate>[1], string]>([
    ["an unknown section", { title: "T", sections: { other: "x" } }, "render/unknown-section"],
    ["an empty title", { title: "  ", sections: {} }, "render/invalid-title"],
    ["a multi-line title", { title: "a\nb", sections: {} }, "render/invalid-title"],
    [
      "a heading line in content",
      { title: "T", sections: { notes: "x\n### Decision  \ny" } },
      "render/heading-in-content",
    ],
  ])("rejects %s", (_, input, rule) => {
    const r = renderTemplate(ADR, input);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? [] : r.findings.map((f) => f.rule)).toEqual([rule]);
  });
});

describe("extractSections", () => {
  it("reads sections in any order and lists missing ones", () => {
    const doc = "# Title\r\n\r\n## Notes\r\nn\r\n## Context\r\nc  \r\n";
    expect(extractSections(ADR, doc)).toEqual({
      title: "Title",
      sections: { context: "c", notes: "n" },
      missing: ["decision"],
    });
  });

  it("finds no title after the first section heading", () => {
    expect(extractSections(ADR, "## Context\n# Late\n").title).toBeNull();
  });
});

describe("render and extract (AC 12)", () => {
  it("round-trips every section map through a rendered document", () => {
    fc.assert(
      fc.property(arbCase, ({ t, title, sections }) => {
        const x = extractSections(t, rendered(t, { title, sections }));
        expect(x.sections).toEqual(mapValues(sections, normalizeSection));
        expect(x.title).toBe(title);
        expect(x.missing).toEqual([]);
      }),
    );
  });

  it("lints a fully rendered document clean, and flags a dropped required section", () => {
    fc.assert(
      fc.property(arbCase, fc.nat(), ({ t, title, sections }, pick) => {
        const required = t.sections.filter((s) => s.required);
        fc.pre(required.every((s) => normalizeSection(sections[s.id] ?? "") !== ""));
        const text = rendered(t, { title, sections });
        expect(lintDocument(t, text)).toEqual([]);

        fc.pre(required.length > 0);
        const dropped = required[pick % required.length];
        const h = dropped?.heading;
        const heading = text.split("\n").find((l) => l === `## ${h}` || l === `### ${h}`);
        const without = text
          .split("\n")
          .filter((l) => l !== heading)
          .join("\n");
        expect(lintDocument(t, without)).toContainEqual(
          expect.objectContaining({ rule: "template/section-missing" }),
        );
      }),
    );
  });
});
