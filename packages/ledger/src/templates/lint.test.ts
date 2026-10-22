import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { lintDocument, lintTemplate } from "./lint.js";
import { parseTemplate, type Template } from "./parse.js";
import { extractSections, renderTemplate } from "./render.js";

const FM = `---
template: t
version: 1
sections:
  - id: context
    heading: Context
    required: true
    guidance: Describe the forces.
  - id: decision
    heading: Decision
    required: false
---
`;
const GOOD =
  "# {{title}}\n\nIntro text is fine.\n\n## Context\n{{context}}\n\n## Decision\n{{decision}}\n";

function template(body: string, fm = FM): Template {
  const r = parseTemplate(fm + body);
  if (!r.ok) throw new Error(`expected a template: ${JSON.stringify(r.findings)}`);
  return r.template;
}
const rules = (body: string, fm = FM) => lintTemplate(template(body, fm)).map((f) => f.rule);

describe("lintTemplate", () => {
  it("passes a clean template, with intro text between the title and the first section", () => {
    expect(rules(GOOD)).toEqual([]);
    expect(rules(GOOD.replace("## Context", "### Context"))).toEqual([]);
  });

  it.each<[string, string, string[]]>([
    [
      "no title line",
      "## Context\n{{context}}\n## Decision\n{{decision}}\n",
      ["template/title-placeholder"],
    ],
    [
      "# ADR: {{title}}",
      GOOD.replace("# {{title}}", "# ADR: {{title}}"),
      ["template/title-placeholder"],
    ],
    [
      "a title line below the first section",
      "## Context\n{{context}}\n\n# {{title}}\n## Decision\n{{decision}}\n",
      ["template/section-text", "template/title-placeholder"],
    ],
    [
      "a second {{title}}",
      GOOD.replace("Intro text is fine.", "{{title}}"),
      ["template/placeholder-duplicate", "template/title-placeholder"],
    ],
    ["another # line before the title", `# Notes\n${GOOD}`, ["template/title-placeholder"]],
    [
      "a section without its placeholder",
      GOOD.replace("{{decision}}", ""),
      // Without its placeholder, ## Decision is no section heading, so it is text in Context.
      ["template/placeholder-missing", "template/section-text"],
    ],
    [
      "a duplicated section placeholder",
      GOOD.replace("{{context}}", "{{context}}\n{{context}}"),
      ["template/placeholder-duplicate"],
    ],
    [
      "an unknown placeholder",
      GOOD.replace("Intro text is fine.", "{{other}}"),
      ["template/placeholder-unknown"],
    ],
    [
      "a heading that doesn't match",
      GOOD.replace("## Context", "## Background"),
      ["template/heading-mismatch"],
    ],
    [
      "text above a placeholder",
      GOOD.replace("{{context}}", "Describe the forces:\n{{context}}"),
      ["template/section-text"],
    ],
    [
      "text around a placeholder",
      GOOD.replace("{{context}}", "Forces: {{context}}"),
      ["template/section-text"],
    ],
    [
      "an indented placeholder",
      GOOD.replace("{{context}}", "  {{context}}"),
      ["template/section-text"],
    ],
    ["text after the last section", `${GOOD}\nFooter\n`, ["template/section-text"]],
  ])("flags %s", (_, body, expected) => {
    expect(rules(body).sort()).toEqual(expected);
  });

  it("reports file line numbers", () => {
    const t = parseTemplate(FM + GOOD.replace("{{context}}", "Forces: {{context}}"), {
      path: "templates/t.md",
    });
    expect(t.findings).toMatchObject([
      { rule: "template/section-text", file: "templates/t.md", line: 18 },
    ]);
  });

  it("flags two sections that would share a heading line", () => {
    const fm = FM.replace("heading: Decision", "heading: Context");
    const body = "# {{title}}\n## Context\n{{context}}\n## Context\n{{decision}}\n";
    expect(rules(body, fm).sort()).toEqual(["template/heading-mismatch", "template/section-text"]);
  });

  it("checks the kind's required sections", () => {
    const t = template(GOOD);
    expect(lintTemplate(t, { requireSections: ["context"] })).toEqual([]);
    expect(
      lintTemplate(t, { requireSections: ["scope", "decision"] }).map((f) => f.message),
    ).toEqual([
      "template t must have a required scope section",
      "template t must have a required decision section",
    ]);
  });

  it("makes render, extract and document lint refuse a template with lint errors", () => {
    const t = template(GOOD.replace("{{decision}}", ""));
    expect(() => renderTemplate(t, { title: "x", sections: {} })).toThrow(InvalidArgumentError);
    expect(() => extractSections(t, "")).toThrow(InvalidArgumentError);
    expect(() => lintDocument(t, "")).toThrow(InvalidArgumentError);
  });
});

describe("lintDocument", () => {
  const t = template(GOOD);
  const doc = (context: string, decision = "We will.") => {
    const r = renderTemplate(t, { title: "Use DynamoDB", sections: { context, decision } });
    if (!r.ok) throw new Error("render failed");
    return r.text;
  };
  const lint = (text: string) =>
    lintDocument(t, text, { file: "docs/adr/decisions/a7c2m9xd-x.md", subject: "a7c2m9xd" });

  it("passes a filled document", () => {
    expect(lint(doc("Orders need single-digit latency."))).toEqual([]);
  });

  it("allows an optional section to be missing or empty", () => {
    expect(lint(doc("Facts.", ""))).toEqual([]);
    expect(lint(doc("Facts.").replace("## Decision\n", ""))).toEqual([]);
  });

  it.each<[string, (d: string) => string, string, number | null]>([
    ["title-missing", (d) => d.replace("# Use DynamoDB\n", ""), "template/title-missing", null],
    ["section-missing", (d) => d.replace("## Context\n", ""), "template/section-missing", null],
    ["section-empty", (d) => d.replace("Facts.", "  \n\t"), "template/section-empty", 5],
    [
      "guidance-left",
      (d) => d.replace("Facts.", "Describe   the\nforces. Then more."),
      "template/guidance-left",
      5,
    ],
  ])("reports %s", (_, edit, rule, line) => {
    expect(lint(edit(doc("Facts.")))).toEqual([
      {
        severity: "error",
        rule,
        message: expect.any(String),
        file: "docs/adr/decisions/a7c2m9xd-x.md",
        line,
        subject: "a7c2m9xd",
        kind: null,
      },
    ]);
  });

  it("checks guidance in optional sections too", () => {
    const fm = FM.replace("required: false", "required: false\n    guidance: Say what we will do.");
    const u = template(GOOD, fm);
    const text = "# T\n## Context\nFacts.\n## Decision\nSay what we will do.\n";
    expect(lintDocument(u, text).map((f) => f.rule)).toEqual(["template/guidance-left"]);
  });
});
