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

/** What to do with an optional section without content: keep its heading, or leave it out. */
export type EmptyOptional = "keep" | "drop";

/**
 * Renders a document: `{{title}}` becomes the trimmed title and each section's placeholder line
 * its normalized content, in one pass (substituted text is never re-scanned). A missing section
 * gets `""` (`missing: "empty"`, the default) or its guidance (`"guidance"`).
 *
 * With `emptyOptional: "drop"`, an optional section whose content is `""` is left out: its
 * template span, from its heading line up to the next template heading line or the end, goes,
 * static text in it included. The text still ends with one newline. Required sections are always
 * kept. The default `"keep"` renders every section.
 */
export function renderTemplate(
  t: Template,
  input: { readonly title: string; readonly sections: Readonly<Record<string, string>> },
  o: { readonly missing?: "empty" | "guidance"; readonly emptyOptional?: EmptyOptional } = {},
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
  const starts = [...s.headingIndex.values()].sort((a, b) => a - b);
  const dropped = new Set<number>();
  let droppedEnd = false;
  if (o.emptyOptional === "drop") {
    for (const sec of t.sections) {
      const h = s.headingIndex.get(sec.id);
      if (sec.required || h === undefined || content.get(sec.id) !== "") continue;
      const next = starts.find((x) => x > h) ?? s.lines.length;
      for (let i = h; i < next; i++) dropped.add(i);
      if (next === s.lines.length) droppedEnd = true;
    }
  }
  const keep = s.lines.map((_, i) => i).filter((i) => !dropped.has(i));
  // A span dropped at the end leaves the blank lines before it; one final newline stays.
  if (droppedEnd) {
    while (keep.length > 0 && s.lines[keep[keep.length - 1] ?? 0] === "") keep.pop();
  }
  const out = keep.map((i) => {
    const line = s.lines[i] ?? "";
    if (i === s.titleLine) return line.replace(/\{\{\s*title\s*\}\}/, () => title);
    const id = placeholderLine.get(i);
    return id === undefined ? line : (content.get(id) ?? "");
  });
  if (droppedEnd) out.push("");
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

/**
 * Replaces the content of the given sections in `doc`, a document written from `t`, and keeps
 * every other line as it is. A section's content runs from the line after its heading to the next
 * template heading line present, or the end; the new content is normalized like
 * `renderTemplate`'s and followed by one blank line, except at the end of the document, which gets
 * a final newline. CRLF input is read as LF and written as LF.
 *
 * With `emptyOptional: "drop"`, empty text for an optional section removes it, from its heading
 * line up to the next template heading line present or the end (nothing to do when it's absent),
 * and text for an absent optional section inserts it before the first later section, in template
 * order, that is present, or at the end. Under the default `"keep"`, an absent section is
 * `render/section-missing`, as it always is for a required one.
 */
export function replaceSections(
  t: Template,
  doc: string,
  sections: Readonly<Record<string, string>>,
  o: { readonly emptyOptional?: EmptyOptional } = {},
): { ok: true; text: string } | { ok: false; findings: Finding[] } {
  const s = lintCleanStructure(t);
  const findings: Finding[] = [];
  const add = (rule: string, message: string) =>
    findings.push(finding({ severity: "error", rule, message }));
  const { at } = extractWith(s, t, doc);
  const byId = new Map(t.sections.map((sec) => [sec.id, sec]));
  const drop = o.emptyOptional === "drop";
  const headings = new Set(s.headingLines.values());
  const content = new Map<string, string>();
  const removals = new Set<string>();
  const inserts = new Map<string, string>();
  for (const [id, given] of Object.entries(sections)) {
    const sec = byId.get(id);
    if (sec === undefined) {
      add("render/unknown-section", `template ${t.name} has no section ${id}`);
      continue;
    }
    const value = normalizeSection(given);
    const optional = drop && !sec.required;
    if (!at.has(id) && !optional) {
      add(
        "render/section-missing",
        `the document has no '${s.headingLines.get(id)}' heading for section ${id}`,
      );
      continue;
    }
    if (value.split("\n").some((l) => headings.has(l))) {
      add(
        "render/heading-in-content",
        `section ${id} contains a section heading line, which would make extraction ambiguous`,
      );
    }
    if (!at.has(id)) {
      if (value !== "") inserts.set(id, value);
    } else if (optional && value === "") {
      removals.add(id);
    } else {
      content.set(id, value);
    }
  }
  if (findings.length > 0) return { ok: false, findings };

  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  const starts = [...at.values()].sort((a, b) => a - b);
  // Replace and remove from the last section up, so earlier line indexes stay valid.
  const order = [...content.keys(), ...removals].sort(
    (a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0),
  );
  for (const id of order) {
    const i = at.get(id) ?? 0;
    const next = starts.find((x) => x > i) ?? lines.length;
    if (removals.has(id)) {
      lines.splice(i, next - i);
      if (i >= lines.length) endWithOneNewline(lines);
      continue;
    }
    const value = content.get(id) ?? "";
    lines.splice(i + 1, next - (i + 1), ...(value === "" ? [] : value.split("\n")), "");
  }
  // Insert in template order, each before the first later section present, else at the end.
  for (const sec of t.sections) {
    const value = inserts.get(sec.id);
    if (value === undefined) continue;
    const present = extractWith(s, t, lines.join("\n")).at;
    const later = t.sections.slice(t.sections.indexOf(sec) + 1);
    const before = later.map((l) => present.get(l.id)).find((i) => i !== undefined);
    const heading = s.headingLines.get(sec.id) ?? "";
    if (before === undefined) {
      endWithOneNewline(lines);
      lines.splice(lines.length - 1, 0, "", heading, ...value.split("\n"));
    } else {
      lines.splice(before, 0, heading, ...value.split("\n"), "");
    }
  }
  return { ok: true, text: lines.join("\n") };
}

/** Trims `lines`' trailing empty lines and adds one, so their text ends with one newline. */
function endWithOneNewline(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push("");
}
