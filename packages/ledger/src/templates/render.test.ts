import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lintDocument } from "./lint.js";
import { parseTemplate, type Template } from "./parse.js";
import { extractSections, normalizeSection, renderTemplate, replaceSections } from "./render.js";

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

describe("replaceSections", () => {
  const doc = rendered(ADR, {
    title: "T",
    sections: { context: "Old context.", decision: "We will.", notes: "A note." },
  });
  const replaced = (d: string, sections: Record<string, string>) => {
    const r = replaceSections(ADR, d, sections);
    if (!r.ok) throw new Error(`replace failed: ${JSON.stringify(r.findings)}`);
    return r.text;
  };

  it("replaces a middle section and keeps every other line", () => {
    const edited = doc.replace("Intro text.", "Intro text, edited by hand.");
    expect(replaced(edited, { decision: "\nWe won't.\n\nReally.  \n" })).toBe(
      edited.replace("We will.", "We won't.\n\nReally."),
    );
  });

  it("replaces the last section with a final newline", () => {
    expect(replaced(doc, { notes: "New note." })).toBe(doc.replace("A note.", "New note."));
    expect(replaced(`${doc.trimEnd()}`, { notes: "x" }).endsWith("## Notes\nx\n")).toBe(true);
  });

  it("empties a section", () => {
    expect(replaced(doc, { context: "" })).toContain("## Context\n\n### Decision\n");
  });

  it("reads CRLF and writes LF", () => {
    expect(replaced(doc.replace(/\n/g, "\r\n"), { context: "New." })).toBe(
      doc.replace("Old context.", "New."),
    );
  });

  it.each<[string, string, Record<string, string>, string]>([
    ["an unknown section", "", { other: "x" }, "render/unknown-section"],
    ["a missing heading", "## Context\n", { decision: "x" }, "render/section-missing"],
    ["a heading in the content", "", { notes: "x\n## Context\ny" }, "render/heading-in-content"],
  ])("rejects %s", (_, d, sections, rule) => {
    const r = replaceSections(ADR, d === "" ? doc : d, sections);
    expect(r.ok ? [] : r.findings.map((f) => f.rule)).toEqual([rule]);
  });

  it("round-trips with extractSections and leaves the other sections and title alone", () => {
    const arb = arbCase.chain((c) =>
      fc.record({
        c: fc.constant(c),
        y: fc
          .subarray(c.t.sections.map((sec) => sec.id))
          .chain((ids) => fc.record(Object.fromEntries(ids.map((id) => [id, arbContent(c.t)])))),
      }),
    );
    fc.assert(
      fc.property(arb, ({ c: { t, title, sections }, y }) => {
        const before = rendered(t, { title, sections });
        const r = replaceSections(t, before, y);
        if (!r.ok) throw new Error(JSON.stringify(r.findings));
        const x = extractSections(t, r.text);
        expect(x.sections).toEqual(mapValues({ ...sections, ...y }, normalizeSection));
        expect(x.title).toBe(title);
        const head = (d: string) => d.split("\n").slice(0, d.split("\n").indexOf(""));
        expect(head(r.text)).toEqual(head(before));
        expect(replaceSections(t, r.text, y)).toEqual(r);
      }),
    );
  });
});

const TASK = template(`---
template: task
version: 1
sections:
  - id: goal
    heading: Goal
    required: true
  - id: notes
    heading: Notes
    required: false
  - id: done
    heading: Done when
    required: true
---
# {{title}}

## Goal
{{goal}}

## Notes
{{notes}}

## Done when
{{done}}
`);

describe("dropEmptyOptional", () => {
  const drop = { dropEmptyOptional: true };
  const full = "# T\n\n## Goal\nG.\n\n## Notes\nN.\n\n## Done when\nD.\n";
  const short = "# T\n\n## Goal\nG.\n\n## Done when\nD.\n";
  const adr = rendered(ADR, {
    title: "T",
    sections: { context: "C.", decision: "We will.", notes: "A note." },
  });
  const adrShort = adr.replace("\n## Notes\nA note.\n", "");
  const replaced = (t: Template, d: string, sections: Record<string, string>) => {
    const r = replaceSections(t, d, sections, drop);
    if (!r.ok) throw new Error(`replace failed: ${JSON.stringify(r.findings)}`);
    return r.text;
  };

  it("renders no heading for an empty optional section, in the middle or last", () => {
    expect(rendered(TASK, { title: "T", sections: { goal: "G.", done: "D." } }, drop)).toBe(short);
    expect(
      rendered(TASK, { title: "T", sections: { goal: "G.", notes: " ", done: "D." } }, drop),
    ).toBe(short);
    expect(
      rendered(TASK, { title: "T", sections: { goal: "G.", notes: "N.", done: "D." } }, drop),
    ).toBe(full);
    expect(adrShort.endsWith("### Decision\nWe will.\n")).toBe(true);
    expect(
      rendered(ADR, { title: "T", sections: { context: "C.", decision: "We will." } }, drop),
    ).toBe(adrShort);
  });

  it("keeps the heading of an empty required section", () => {
    expect(rendered(TASK, { title: "T", sections: { goal: "G." } }, drop)).toBe(
      "# T\n\n## Goal\nG.\n\n## Done when\n\n",
    );
  });

  it("removes an optional section with empty content and adds it back in the template's order", () => {
    expect(replaced(TASK, full, { notes: "" })).toBe(short);
    expect(replaced(TASK, short, { notes: "" })).toBe(short);
    expect(replaced(TASK, short, { notes: "N." })).toBe(full);
    expect(replaced(TASK, short, { notes: "N.", goal: "G." })).toBe(full);
    expect(replaced(ADR, adr, { notes: "" })).toBe(adrShort);
    expect(replaced(ADR, adrShort, { notes: "A note." })).toBe(adr);
    expect(replaced(ADR, adrShort.trimEnd(), { notes: "A note." })).toBe(adr);
  });

  it("keeps an empty required section and refuses a missing one", () => {
    expect(replaced(TASK, full, { done: "" })).toBe(
      full.replace("## Done when\nD.\n", "## Done when\n"),
    );
    const r = replaceSections(
      TASK,
      short.replace("\n## Done when\nD.\n", ""),
      { done: "D." },
      drop,
    );
    expect(r.ok ? [] : r.findings.map((f) => f.rule)).toEqual(["render/section-missing"]);
    const plain = replaceSections(TASK, short, { notes: "N." });
    expect(plain.ok ? [] : plain.findings.map((f) => f.rule)).toEqual(["render/section-missing"]);
  });

  it("lints a document without an optional section clean, and reports a missing required one", () => {
    expect(lintDocument(TASK, short)).toEqual([]);
    expect(lintDocument(TASK, "# T\n\n## Goal\nG.\n").map((f) => f.rule)).toEqual([
      "template/section-missing",
    ]);
  });
});
