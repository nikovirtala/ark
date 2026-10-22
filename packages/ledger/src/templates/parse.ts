import { isMap, LineCounter, parseDocument } from "yaml";
import { type Finding, finding } from "../findings/finding.js";

/** One section of a template's frontmatter schema. */
export interface SectionSpec {
  readonly id: string;
  readonly heading: string;
  readonly required: boolean;
  readonly guidance: string | null;
}

export interface Template {
  readonly name: string;
  readonly version: number;
  readonly sections: readonly SectionSpec[];
  /** The markdown after the frontmatter, with LF line endings. */
  readonly body: string;
  readonly path: string | null;
  /** Unknown frontmatter keys, preserved and ignored. */
  readonly extra: Readonly<Record<string, unknown>>;
}

export type TemplateParse =
  | { readonly ok: true; readonly template: Template; readonly findings: Finding[] }
  | { readonly ok: false; readonly findings: Finding[] };

/** Template files larger than this are reported as `template/frontmatter` without parsing. */
export const MAX_TEMPLATE_BYTES = 1_048_576;

const NAME = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ATX_HEADING = /^#{1,6}(?:[ \t]+(.*?))?[ \t]*$/;
const encoder = new TextEncoder();

/** Lines of the body before it, per template, so findings can carry file line numbers. */
const bodyOffsets = new WeakMap<Template, number>();

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function basename(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function validateSections(value: unknown, fail: (message: string) => void): SectionSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("sections must be a non-empty list");
    return [];
  }
  const sections: SectionSpec[] = [];
  const ids = new Set<string>();
  value.forEach((s: unknown, i) => {
    const where = `sections[${i}]`;
    if (!isMapping(s)) {
      fail(`${where} must be a mapping`);
      return;
    }
    const { id, heading, required, guidance } = s;
    let ok = true;
    const bad = (message: string) => {
      ok = false;
      fail(`${where}.${message}`);
    };
    if (typeof id !== "string" || !NAME.test(id)) bad(`id must match ${NAME.source}`);
    else if (id === "title") bad("id title is reserved");
    else if (ids.has(id)) bad(`id ${id} is not unique`);
    if (typeof heading !== "string" || heading.trim() === "" || /[\r\n]/.test(heading)) {
      bad("heading must be a non-empty single line");
    }
    if (required !== undefined && required !== null && typeof required !== "boolean") {
      bad("required must be a boolean");
    }
    if (guidance !== undefined && guidance !== null && typeof guidance !== "string") {
      bad("guidance must be a string");
    }
    if (!ok || typeof id !== "string" || typeof heading !== "string") return;
    ids.add(id);
    sections.push({
      id,
      heading,
      required: required === true,
      guidance: typeof guidance === "string" ? guidance : null,
    });
  });
  return sections;
}

/**
 * Parses a template file: the `---` frontmatter block (YAML, with the event codec's safety
 * options) holding the section schema, then the markdown body. Frontmatter and schema problems
 * fail the parse; the body's syntax lint comes back as findings of a successful parse.
 */
export function parseTemplate(text: string, o: { readonly path?: string } = {}): TemplateParse {
  const file = o.path ?? null;
  const findings: Finding[] = [];
  const add = (rule: string, message: string, line: number | null = null) =>
    findings.push(finding({ severity: "error", rule, message, file, line }));
  const size = encoder.encode(text).byteLength;
  if (size > MAX_TEMPLATE_BYTES) {
    add("template/frontmatter", `template is ${size} bytes; the limit is ${MAX_TEMPLATE_BYTES}`);
    return { ok: false, findings };
  }
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text)
    .replace(/\r\n/g, "\n")
    .split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) {
    add("template/frontmatter", "template must start with a --- frontmatter block", 1);
    return { ok: false, findings };
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(lines.slice(1, end).join("\n"), {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    strict: true,
    prettyErrors: true,
    lineCounter,
  });
  const error = doc.errors[0];
  let fm: unknown;
  if (error === undefined) {
    try {
      fm = doc.toJS({ maxAliasCount: 0 });
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      add("template/frontmatter", `invalid frontmatter: ${e.message}`);
      return { ok: false, findings };
    }
  } else {
    const first = error.message.split("\n", 1)[0]?.replace(/ at line \d+, column \d+:?$/, "");
    const line = error.linePos?.[0].line;
    add(
      "template/frontmatter",
      `invalid frontmatter: ${first}`,
      line === undefined ? null : line + 1,
    );
    return { ok: false, findings };
  }
  if (!isMap(doc.contents) || !isMapping(fm)) {
    add("template/frontmatter", "frontmatter must be a mapping", 2);
    return { ok: false, findings };
  }

  const { template: name, version, sections: rawSections, ...extra } = fm;
  const schema = (message: string) => add("template/schema", message);
  if (typeof name !== "string" || !NAME.test(name)) schema(`template must match ${NAME.source}`);
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    schema("version must be an integer of at least 1");
  }
  const sections = validateSections(rawSections, schema);
  if (findings.length > 0 || typeof name !== "string" || typeof version !== "number") {
    return { ok: false, findings };
  }
  if (file !== null && basename(file) !== name) {
    add("template/name-mismatch", `template ${name} must be in a file named ${name}.md`);
  }
  const template: Template = {
    name,
    version,
    sections,
    body: lines.slice(end + 1).join("\n"),
    path: file,
    extra,
  };
  bodyOffsets.set(template, end + 1);
  findings.push(...templateStructure(template).findings);
  return { ok: true, template, findings };
}

/** The resolved layout of a template body. Internal to the templates layer. */
export interface TemplateStructure {
  readonly lines: readonly string[];
  /** Body line index of `# {{title}}`, when the title rule holds. */
  readonly titleLine: number | null;
  /** Section id → the exact body line used as its heading line. */
  readonly headingLines: ReadonlyMap<string, string>;
  /** Section id → body line index of its heading line. */
  readonly headingIndex: ReadonlyMap<string, number>;
  /** The template-lint findings (every syntax rule except `required-section`). */
  readonly findings: readonly Finding[];
}

const structures = new WeakMap<Template, TemplateStructure>();

/** Applies the template syntax rules and resolves each section's heading line. Memoized. */
export function templateStructure(t: Template): TemplateStructure {
  const cached = structures.get(t);
  if (cached !== undefined) return cached;
  const offset = bodyOffsets.get(t) ?? 0;
  const lines = t.body.split("\n");
  const findings: Finding[] = [];
  const add = (rule: string, message: string, index: number | null = null) =>
    findings.push(
      finding({
        severity: "error",
        rule,
        message,
        file: t.path,
        line: index === null ? null : index + offset + 1,
      }),
    );
  const ids = new Set(t.sections.map((s) => s.id));

  const occurrences = new Map<string, number[]>();
  lines.forEach((line, i) => {
    for (const m of line.matchAll(PLACEHOLDER)) {
      const name = m[1] ?? "";
      occurrences.set(name, [...(occurrences.get(name) ?? []), i]);
    }
  });
  for (const [name, at] of occurrences) {
    if (name !== "title" && !ids.has(name)) {
      add("template/placeholder-unknown", `unknown placeholder {{${name}}}`, at[0] ?? null);
    }
    if (at.length > 1) {
      add(
        "template/placeholder-duplicate",
        `placeholder {{${name}}} appears ${at.length} times`,
        at[1] ?? null,
      );
    }
  }

  const headingLines = new Map<string, string>();
  const headingIndex = new Map<string, number>();
  const owner = new Map<number, string>();
  for (const s of t.sections) {
    const at = occurrences.get(s.id)?.[0];
    if (at === undefined) {
      add("template/placeholder-missing", `section ${s.id} has no {{${s.id}}} placeholder`);
      continue;
    }
    let h = at - 1;
    while (h >= 0 && !ATX_HEADING.test(lines[h] ?? "")) h--;
    const text = h < 0 ? null : (ATX_HEADING.exec(lines[h] ?? "")?.[1] ?? "").trim();
    if (text !== s.heading.trim()) {
      add(
        "template/heading-mismatch",
        `the heading above {{${s.id}}} must be ${JSON.stringify(s.heading.trim())}`,
        at,
      );
      continue;
    }
    const other = owner.get(h);
    const line = (lines[h] ?? "").trimEnd();
    const sameText = [...headingLines].find(([, l]) => l === line)?.[0];
    if (other !== undefined || sameText !== undefined) {
      add(
        "template/heading-mismatch",
        `section ${s.id} shares its heading line with section ${other ?? sameText}`,
        h,
      );
      continue;
    }
    owner.set(h, s.id);
    headingLines.set(s.id, line);
    headingIndex.set(s.id, h);
  }

  const starts = [...headingIndex.values()].sort((a, b) => a - b);
  for (const [id, h] of headingIndex) {
    const next = starts.find((x) => x > h) ?? lines.length;
    for (let i = h + 1; i < next; i++) {
      const line = (lines[i] ?? "").trimEnd();
      if (line === "" || line === `{{${id}}}`) continue;
      add(
        "template/section-text",
        `section ${id} must hold only its {{${id}}} line; put guidance in the frontmatter`,
        i,
      );
      break;
    }
  }

  const titleLines = lines.flatMap((l, i) => (l.trimEnd() === "# {{title}}" ? [i] : []));
  const titleAt = titleLines[0];
  const firstSection = starts[0] ?? lines.length;
  const titleOk =
    titleLines.length === 1 &&
    titleAt !== undefined &&
    titleAt < firstSection &&
    (occurrences.get("title") ?? []).length === 1 &&
    !lines.slice(0, titleAt).some((l) => l.startsWith("# "));
  if (!titleOk) {
    add(
      "template/title-placeholder",
      "the body must have exactly one # {{title}} line, as its first # line, before the first section",
      titleAt ?? null,
    );
  }

  const s: TemplateStructure = {
    lines,
    titleLine: titleOk ? (titleAt ?? null) : null,
    headingLines,
    headingIndex,
    findings,
  };
  structures.set(t, s);
  return s;
}
