import { InvalidArgumentError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import { type Template, type TemplateStructure, templateStructure } from "./parse.js";

/**
 * The single whitespace rule for sections: CRLF to LF, trailing whitespace removed from every
 * line, leading and trailing blank lines removed. Leading spaces of a non-blank line are kept.
 */
export function normalizeSection(s: string): string {
  const lines = s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  return lines.slice(start, end).join("\n");
}

/** The template's structure; throws `InvalidArgumentError` when it has template-lint errors. */
export function lintCleanStructure(t: Template): TemplateStructure {
  const s = templateStructure(t);
  if (s.findings.length > 0) {
    throw new InvalidArgumentError(
      `template ${t.name} has lint errors: ${s.findings.map((f) => f.rule).join(", ")}`,
    );
  }
  return s;
}

/**
 * Renders a document: `{{title}}` becomes the trimmed title and each section's placeholder line
 * its normalized content, in one pass (substituted text is never re-scanned). A missing section
 * gets `""` (`missing: "empty"`, the default) or its guidance (`"guidance"`).
 */
export function renderTemplate(
  t: Template,
  input: { readonly title: string; readonly sections: Readonly<Record<string, string>> },
  o: { readonly missing?: "empty" | "guidance" } = {},
): { ok: true; text: string } | { ok: false; findings: Finding[] } {
  const s = lintCleanStructure(t);
  const findings: Finding[] = [];
  const add = (rule: string, message: string) =>
    findings.push(finding({ severity: "error", rule, message }));
  const title = input.title.trim();
  if (title === "" || /[\r\n]/.test(title)) {
    add("render/invalid-title", "the title must be a non-empty single line");
  }
  const byId = new Map(t.sections.map((sec) => [sec.id, sec]));
  for (const id of Object.keys(input.sections)) {
    if (!byId.has(id)) add("render/unknown-section", `template ${t.name} has no section ${id}`);
  }
  const headings = new Set(s.headingLines.values());
  const content = new Map<string, string>();
  for (const sec of t.sections) {
    const given = Object.hasOwn(input.sections, sec.id) ? input.sections[sec.id] : undefined;
    const value = normalizeSection(given ?? (o.missing === "guidance" ? (sec.guidance ?? "") : ""));
    if (value.split("\n").some((l) => headings.has(l))) {
      add(
        "render/heading-in-content",
        `section ${sec.id} contains a section heading line, which would make extraction ambiguous`,
      );
    }
    content.set(sec.id, value);
  }
  if (findings.length > 0) return { ok: false, findings };

  const placeholderLine = new Map<number, string>();
  for (const [id, h] of s.headingIndex) {
    const at = s.lines.findIndex((l, i) => i > h && l.trimEnd() === `{{${id}}}`);
    placeholderLine.set(at, id);
  }
  const out = s.lines.map((line, i) => {
    if (i === s.titleLine) return line.replace(/\{\{\s*title\s*\}\}/, () => title);
    const id = placeholderLine.get(i);
    return id === undefined ? line : (content.get(id) ?? "");
  });
  return { ok: true, text: out.join("\n") };
}

/**
 * Splits a document into sections by the template's heading lines. A section's content is the
 * normalized text up to the next template heading line present, or EOF; a section whose heading
 * line is absent is listed in `missing`. The title is the first `# ` line before the first
 * section heading.
 */
export function extractSections(
  t: Template,
  doc: string,
): { title: string | null; sections: Record<string, string>; missing: string[] } {
  const { title, sections, missing } = extractWith(lintCleanStructure(t), t, doc);
  return { title, sections, missing };
}

/** `extractSections` for a known-clean structure, also returning each heading's line index. */
export function extractWith(
  s: TemplateStructure,
  t: Template,
  doc: string,
): {
  title: string | null;
  sections: Record<string, string>;
  missing: string[];
  at: Map<string, number>;
} {
  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  const at = new Map<string, number>();
  const missing: string[] = [];
  for (const sec of t.sections) {
    const heading = s.headingLines.get(sec.id);
    const i = lines.findIndex((l) => l.trimEnd() === heading);
    if (i < 0) missing.push(sec.id);
    else at.set(sec.id, i);
  }
  const starts = [...at.values()].sort((a, b) => a - b);
  const sections: Record<string, string> = {};
  for (const sec of t.sections) {
    const i = at.get(sec.id);
    if (i === undefined) continue;
    const next = starts.find((x) => x > i) ?? lines.length;
    sections[sec.id] = normalizeSection(lines.slice(i + 1, next).join("\n"));
  }
  const titleLine = lines.slice(0, starts[0] ?? lines.length).find((l) => l.startsWith("# "));
  return {
    title: titleLine === undefined ? null : titleLine.slice(2).trim(),
    sections,
    missing,
    at,
  };
}
