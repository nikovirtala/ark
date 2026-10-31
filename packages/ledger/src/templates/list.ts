/** The template listing behind `<tool>_templates`: the templates a new document can use. */
import type { Finding } from "../findings/finding.js";
import type { TreeReader } from "../git/tree.js";
import { loadTemplates } from "./history.js";
import { lintTemplate } from "./lint.js";
import { parseTemplate, type Template } from "./parse.js";

/** One listed template. */
export interface ListedTemplate {
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
}

/**
 * The templates of `<root>/templates` that parse and pass the template lint with
 * `requireSections`, and the `builtins` (name → template text) no repo template or file of the
 * same name shadows, sorted by name. `findings` say why a repo template is left out.
 */
export async function listKindTemplates(
  tree: TreeReader,
  root: string,
  o: {
    readonly requireSections: readonly string[];
    readonly builtins: Readonly<Record<string, string>>;
  },
): Promise<{ templates: ListedTemplate[]; findings: Finding[] }> {
  const loaded = await loadTemplates(tree, `${root}/templates`);
  const findings: Finding[] = [...loaded.findings];
  const listed: { template: Template; source: "repo" | "builtin" }[] = [];
  for (const t of loaded.templates.values()) {
    const problems = lintTemplate(t, { requireSections: o.requireSections });
    findings.push(...problems);
    if (problems.length === 0) listed.push({ template: t, source: "repo" });
  }
  for (const [name, text] of Object.entries(o.builtins)) {
    // A repo file of that name shadows it even when broken: the tool would read the file.
    if (loaded.templates.has(name)) continue;
    if ((await tree.read(`${root}/templates/${name}.md`)) !== null) continue;
    const parsed = parseTemplate(text);
    if (parsed.ok) listed.push({ template: parsed.template, source: "builtin" });
  }
  listed.sort((a, b) => (a.template.name < b.template.name ? -1 : 1));
  return {
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
    findings,
  };
}
