import { type Finding, listKindTemplates } from "@nikovirtala/ledger";
import { issueKind } from "../kind.js";
import { type IssuesRead, readNotes } from "../log.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";

/** `issues_templates` (and roadmap step 4's `issues template list --json`): the templates. */
export interface IssueTemplatesJson {
  readonly format: "issues-templates/v1";
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

/**
 * The templates of `<root>/templates` that parse and pass the template lint, and the built-in
 * ones no repo template or file of the same name shadows (`issues new` copies those on first
 * use), sorted by name.
 */
export async function listTemplates(read: IssuesRead): Promise<IssueTemplatesJson> {
  const listed = await listKindTemplates(read.tree, read.root, {
    requireSections: issueKind.def.templates?.requireSections ?? [],
    builtins: BUILTIN_TEMPLATES,
  });
  return {
    format: "issues-templates/v1",
    root: read.root,
    default: read.issues.defaultTemplate,
    templates: listed.templates,
    findings: listed.findings.map((f) => ({ ...f, kind: issueKind.name })),
    notes: readNotes(read),
  };
}
