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
 * gets `""` (`missing: "empty"`, the default) or its guidance (`"guidance"`). With
 * `dropEmptyOptional`, an optional section whose content is empty is left out, heading and all.
 */
export function renderTemplate(
  t: Template,
  input: { readonly title: string; readonly sections: Readonly<Record<string, string>> },
  o: { readonly missing?: "empty" | "guidance"; readonly dropEmptyOptional?: boolean } = {},
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
  const dropped = new Set<number>();
  if (o.dropEmptyOptional === true) {
    const starts = [...s.headingIndex.values()].sort((a, b) => a - b);
    for (const sec of t.sections) {
      const h = s.headingIndex.get(sec.id);
      if (sec.required || h === undefined || content.get(sec.id) !== "") continue;
      const next = starts.find((x) => x > h) ?? s.lines.length;
      for (let i = h; i < next; i++) dropped.add(i);
    }
  }
  const out = s.lines.flatMap((line, i) => {
    if (dropped.has(i)) return [];
    if (i === s.titleLine) return [line.replace(/\{\{\s*title\s*\}\}/, () => title)];
    const id = placeholderLine.get(i);
    return [id === undefined ? line : (content.get(id) ?? "")];
  });
  // A dropped last section leaves the blank lines before it: end as the template does.
  if (dropped.has(s.lines.length - 1)) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    if (s.lines[s.lines.length - 1] === "") out.push("");
  }
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
 * With `dropEmptyOptional`, empty content removes an optional section, heading and all (and does
 * nothing when it is absent), and content for an absent optional section adds it back in the
 * template's order: before the next of the template's sections that is present, or at the end.
 */
export function replaceSections(
  t: Template,
  doc: string,
  sections: Readonly<Record<string, string>>,
  o: { readonly dropEmptyOptional?: boolean } = {},
): { ok: true; text: string } | { ok: false; findings: Finding[] } {
  const s = lintCleanStructure(t);
  const findings: Finding[] = [];
  const add = (rule: string, message: string) =>
    findings.push(finding({ severity: "error", rule, message }));
  const { at } = extractWith(s, t, doc);
  const byId = new Map(t.sections.map((sec) => [sec.id, sec]));
  const optional = (id: string) => o.dropEmptyOptional === true && byId.get(id)?.required === false;
  const headings = new Set(s.headingLines.values());
  const content = new Map<string, string>();
  for (const [id, given] of Object.entries(sections)) {
    if (!byId.has(id)) {
      add("render/unknown-section", `template ${t.name} has no section ${id}`);
      continue;
    }
    const value = normalizeSection(given);
    if (!at.has(id) && !optional(id)) {
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
    content.set(id, value);
  }
  if (findings.length > 0) return { ok: false, findings };

  // The document as its lines before the first section, then one block per section present, in
  // the document's order: the heading line and everything up to the next section's heading.
  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  const starts = [...at.entries()].sort((a, b) => a[1] - b[1]);
  const prefix = lines.slice(0, starts[0]?.[1] ?? lines.length);
  let blocks = starts.map(([id, i], k) => ({
    id,
    lines: lines.slice(i, starts[k + 1]?.[1] ?? lines.length),
  }));
  const blockOf = (id: string, value: string) => [
    s.headingLines.get(id) ?? "",
    ...(value === "" ? [] : value.split("\n")),
    "",
  ];
  let endChanged = false;
  for (const [id, value] of content) {
    const present = blocks.findIndex((b) => b.id === id);
    if (present >= 0) {
      if (value === "" && optional(id)) {
        endChanged ||= present === blocks.length - 1;
        blocks.splice(present, 1);
      } else {
        blocks[present] = { id, lines: blockOf(id, value) };
      }
      continue;
    }
    if (value === "") continue;
    // Absent and optional: before the next of the template's sections that is present.
    const order = t.sections.map((sec) => sec.id);
    const later = new Set(order.slice(order.indexOf(id) + 1));
    const before = blocks.findIndex((b) => later.has(b.id));
    const block = { id, lines: blockOf(id, value) };
    if (before >= 0) {
      blocks.splice(before, 0, block);
    } else {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.lines[last.lines.length - 1] !== "") last.lines.push("");
      blocks = [...blocks, block];
      endChanged = true;
    }
  }
  const out = [...prefix, ...blocks.flatMap((b) => b.lines)];
  // A removed last section leaves the blank lines before it: end with one final newline.
  if (endChanged) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push("");
  }
  return { ok: true, text: out.join("\n") };
}
