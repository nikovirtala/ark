import { describe, expect, it } from "vitest";
import { lintTemplate } from "./lint.js";
import { MAX_TEMPLATE_BYTES, parseTemplate, type Template } from "./parse.js";

// Copied from docs/01-adr-v1.md §Templates and customization.
const TEAM_LIGHTWEIGHT = `---
template: team-lightweight
version: 2
sections:
  - id: context
    heading: Context
    required: true
    guidance: What forces and constraints led here? Facts, not opinions.
  - id: options
    heading: Options considered
    required: false
    guidance: At least two options with one-line trade-offs.
  - id: decision
    heading: Decision
    required: true
    guidance: One or two sentences, in active voice. "We will…"
  - id: scope
    heading: Scope
    required: true
    guidance: What this decision governs, in words. Globs map it to files.
  - id: consequences
    heading: Consequences
    required: true
    guidance: What becomes easier, what becomes harder.
---
# {{title}}

## Context
{{context}}

## Options considered
{{options}}

## Decision
{{decision}}

## Scope
{{scope}}

## Consequences
{{consequences}}
`;

// Copied from docs/02-issues-v1.md §Templates and customization.
const BUG = `---
template: bug
version: 1
sections:
  - id: summary
    heading: Summary
    required: true
    guidance: One or two sentences on what is wrong, for whom.
  - id: reproduce
    heading: Steps to reproduce
    required: true
    guidance: Numbered steps from a clean state. Include versions.
  - id: expected
    heading: Expected
    required: true
    guidance: What should have happened.
  - id: actual
    heading: Actual
    required: true
    guidance: What happened instead. Paste errors as code blocks.
  - id: done
    heading: Done when
    required: true
    guidance: Observable conditions that make this issue finished.
---
# {{title}}

## Summary
{{summary}}

## Steps to reproduce
{{reproduce}}

## Expected
{{expected}}

## Actual
{{actual}}

## Done when
{{done}}
`;

function parsed(text: string, path?: string): Template {
  const r = parseTemplate(text, path === undefined ? {} : { path });
  if (!r.ok) throw new Error(`expected a template: ${JSON.stringify(r.findings)}`);
  return r.template;
}

const rules = (r: ReturnType<typeof parseTemplate>) => r.findings.map((f) => f.rule);

describe("parseTemplate", () => {
  it("parses the 01 team-lightweight template, which lints clean", () => {
    const r = parseTemplate(TEAM_LIGHTWEIGHT, { path: "docs/adr/templates/team-lightweight.md" });
    expect(r).toMatchObject({ ok: true, findings: [] });
    const t = parsed(TEAM_LIGHTWEIGHT);
    expect(t).toMatchObject({ name: "team-lightweight", version: 2, path: null, extra: {} });
    expect(t.sections.map((s) => s.id)).toEqual([
      "context",
      "options",
      "decision",
      "scope",
      "consequences",
    ]);
    expect(t.sections[1]).toEqual({
      id: "options",
      heading: "Options considered",
      required: false,
      guidance: "At least two options with one-line trade-offs.",
    });
    expect(t.body.startsWith("# {{title}}\n")).toBe(true);
    expect(lintTemplate(t, { requireSections: ["scope"] })).toEqual([]);
  });

  it("parses the 02 bug template, which lints clean", () => {
    const r = parseTemplate(BUG, { path: "bug.md" });
    expect(r).toMatchObject({ ok: true, findings: [] });
    expect(lintTemplate(parsed(BUG), { requireSections: ["done"] })).toEqual([]);
  });

  it("tolerates CRLF and a BOM, and keeps unknown frontmatter keys in extra", () => {
    const text = `\uFEFF${BUG.replace("version: 1\n", "version: 1\nowner: qa\n").replace(/\n/g, "\r\n")}`;
    const t = parsed(text);
    expect(t.extra).toEqual({ owner: "qa" });
    expect(t.body).not.toContain("\r");
    expect(parseTemplate(text).findings).toEqual([]);
  });

  it("defaults required to false and guidance to null", () => {
    const t = parsed(
      "---\ntemplate: t\nversion: 1\nsections:\n  - id: a\n    heading: A\n---\n# {{title}}\n## A\n{{a}}\n",
    );
    expect(t.sections).toEqual([{ id: "a", heading: "A", required: false, guidance: null }]);
  });

  it.each<[string, string]>([
    ["no frontmatter", "# {{title}}\n"],
    ["an unterminated block", "---\ntemplate: t\n"],
    ["invalid yaml", "---\ntemplate: [\n---\n"],
    ["duplicate keys", "---\ntemplate: t\ntemplate: u\n---\n"],
    ["an alias", "---\na: &x 1\nb: *x\n---\n"],
    ["a non-mapping", "---\n- a\n---\n"],
  ])("reports template/frontmatter for %s", (_, text) => {
    const r = parseTemplate(text, { path: "t.md" });
    expect(r.ok).toBe(false);
    expect(rules(r)).toEqual(["template/frontmatter"]);
    expect(r.findings[0]?.file).toBe("t.md");
  });

  it("reports the frontmatter line of a YAML error", () => {
    const r = parseTemplate("---\ntemplate: t\nversion: 1\nversion: 2\n---\n");
    expect(r.findings[0]?.line).toBe(4);
  });

  it("reports an oversized template", () => {
    const r = parseTemplate(`---\n# ${"x".repeat(MAX_TEMPLATE_BYTES)}\n---\n`);
    expect(r).toMatchObject({ ok: false });
    expect(r.findings[0]?.message).toContain("bytes; the limit is");
  });

  it.each<[string, string, string]>([
    ["template", "template: Bad", "template must match"],
    ["template missing", "", "template must match"],
    ["version", "version: 0", "version must be an integer"],
    ["version float", "version: 1.5", "version must be an integer"],
    ["sections empty", "sections: []", "sections must be a non-empty list"],
    ["section mapping", "sections: [x]", "sections[0] must be a mapping"],
    ["id", "sections: [{ id: Bad, heading: H }]", "sections[0].id must match"],
    ["id title", "sections: [{ id: title, heading: H }]", "sections[0].id title is reserved"],
    [
      "id unique",
      "sections: [{ id: a, heading: A }, { id: a, heading: B }]",
      "sections[1].id a is not unique",
    ],
    ["heading", "sections: [{ id: a, heading: ' ' }]", "sections[0].heading must be a non-empty"],
    ["heading line", 'sections: [{ id: a, heading: "A\\nB" }]', "single line"],
    ["required", "sections: [{ id: a, heading: A, required: yes }]", "required must be a boolean"],
    ["guidance", "sections: [{ id: a, heading: A, guidance: 3 }]", "guidance must be a string"],
  ])("reports template/schema for %s", (_, field, message) => {
    const defaults: Record<string, string> = {
      template: "template: t",
      version: "version: 1",
      sections: "sections: [{ id: a, heading: A }]",
    };
    const key = field === "" ? "template" : (field.split(":")[0] ?? "");
    const fm = Object.entries({ ...defaults, [key]: field })
      .map(([, v]) => v)
      .filter((v) => v !== "")
      .join("\n");
    const r = parseTemplate(`---\n${fm}\n---\n# {{title}}\n## A\n{{a}}\n`);
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("template/schema");
    expect(r.findings.map((f) => f.message).join("\n")).toContain(message);
  });

  it("reports template/name-mismatch when the file name differs", () => {
    const r = parseTemplate(BUG, { path: "templates/defect.md" });
    expect(r.ok).toBe(true);
    expect(rules(r)).toEqual(["template/name-mismatch"]);
  });
});
