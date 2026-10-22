import { type Finding, finding } from "../findings/finding.js";
import { type Template, templateStructure } from "./parse.js";
import { extractWith, lintCleanStructure } from "./render.js";

/**
 * Template syntax lint. `requireSections` is the kind's domain hook: each listed section must
 * exist and be `required` (adr passes `["scope"]`, issues `["done"]`).
 */
export function lintTemplate(
  t: Template,
  o: { readonly requireSections?: readonly string[] } = {},
): Finding[] {
  const findings = [...templateStructure(t).findings];
  for (const id of o.requireSections ?? []) {
    if (t.sections.some((s) => s.id === id && s.required)) continue;
    findings.push(
      finding({
        severity: "error",
        rule: "template/required-section",
        message: `template ${t.name} must have a required ${id} section`,
        file: t.path,
      }),
    );
  }
  return findings;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Lints a document against its template: a title, every required section present and non-empty,
 * and no guidance text left in any section.
 */
export function lintDocument(
  t: Template,
  doc: string,
  o: { readonly file?: string; readonly subject?: string } = {},
): Finding[] {
  const x = extractWith(lintCleanStructure(t), t, doc);
  const findings: Finding[] = [];
  const add = (rule: string, message: string, line: number | null = null) =>
    findings.push(
      finding({
        severity: "error",
        rule,
        message,
        file: o.file ?? null,
        line,
        subject: o.subject ?? null,
      }),
    );
  if (x.title === null) add("template/title-missing", "the document has no # title line");
  for (const s of t.sections) {
    const content = x.sections[s.id];
    const heading = x.at.get(s.id);
    const line = heading === undefined ? null : heading + 1;
    if (content === undefined) {
      if (s.required) add("template/section-missing", `required section ${s.heading} is missing`);
      continue;
    }
    if (s.required && content === "") {
      add("template/section-empty", `required section ${s.heading} is empty`, line);
    }
    const guidance = s.guidance === null ? "" : collapse(s.guidance);
    if (guidance !== "" && collapse(content).includes(guidance)) {
      add("template/guidance-left", `section ${s.heading} still contains its guidance text`, line);
    }
  }
  return findings;
}
