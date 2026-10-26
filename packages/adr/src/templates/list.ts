import {
  type Finding,
  lintTemplate,
  loadTemplates,
  parseTemplate,
  type Template,
} from "@nikovirtala/ledger";
import { adrKind } from "../kind.js";
import type { DecisionsRead } from "../log.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";

/** `adr_templates` (and phase 4's `adr template list --json`): the templates a proposal can use. */
export interface TemplatesJson {
  readonly format: "adr-templates/v1";
  readonly root: string;
  /** `[log] default_template`. */
  readonly default: string;
  readonly templates: readonly {
    readonly name: string;
    readonly version: number;
    readonly source: "repo" | "builtin";
    /** `<root>/templates/<name>.md` for a repo template; `null` for a built-in one. */
    readonly path: string | null;
    readonly sections: readonly {
      readonly id: string;
      readonly heading: string;
      readonly required: boolean;
      readonly guidance: string | null;
    }[];
  }[];
  /** Why a repo template is left out: it doesn't parse or fails the template lint. */
  readonly findings: readonly Finding[];
  readonly notes: readonly string[];
}

const lint = (t: Template) =>
  lintTemplate(t, { requireSections: adrKind.def.templates?.requireSections ?? [] });

/**
 * The templates of `<root>/templates` that parse and pass the template lint, and the built-in
 * ones no repo template or file of the same name shadows (`adr new` copies those on first use),
 * sorted by name.
 */
export async function listTemplates(read: DecisionsRead): Promise<TemplatesJson> {
  const loaded = await loadTemplates(read.tree, `${read.root}/templates`);
  const findings: Finding[] = [...loaded.findings];
  const listed: { template: Template; source: "repo" | "builtin" }[] = [];
  for (const t of loaded.templates.values()) {
    const problems = lint(t);
    findings.push(...problems);
    if (problems.length === 0) listed.push({ template: t, source: "repo" });
  }
  for (const [name, text] of Object.entries(BUILTIN_TEMPLATES)) {
    // A repo file of that name shadows it even when broken: `adr new` would read the file.
    if (loaded.templates.has(name)) continue;
    if ((await read.tree.read(`${read.root}/templates/${name}.md`)) !== null) continue;
    const parsed = parseTemplate(text);
    if (parsed.ok) listed.push({ template: parsed.template, source: "builtin" });
  }
  listed.sort((a, b) => (a.template.name < b.template.name ? -1 : 1));
  return {
    format: "adr-templates/v1",
    root: read.root,
    default: read.adr.defaultTemplate,
    templates: listed.map(({ template: t, source }) => ({
      name: t.name,
      version: t.version,
      source,
      path: source === "repo" ? t.path : null,
      sections: t.sections.map((s) => ({
        id: s.id,
        heading: s.heading,
        required: s.required,
        guidance: s.guidance,
      })),
    })),
    findings: findings.map((f) => ({ ...f, kind: adrKind.name })),
    notes: read.notes,
  };
}
