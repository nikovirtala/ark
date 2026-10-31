import { describe, expect, it } from "vitest";
import { MemoryTree } from "../git/tree.js";
import { listKindTemplates } from "./list.js";

const template = (name: string, o: { readonly doneRequired?: boolean } = {}) => `---
template: ${name}
version: 2
sections:
  - id: done
    heading: Done when
    required: ${o.doneRequired ?? true}
    guidance: Say when it's done.
---
# {{title}}

## Done when
{{done}}
`;

const BUILTINS = { basic: template("basic"), lean: template("lean"), zeta: template("zeta") };
const list = (files: Readonly<Record<string, string>>) =>
  listKindTemplates(new MemoryTree(files), "docs/x", {
    requireSections: ["done"],
    builtins: BUILTINS,
  });

describe("listKindTemplates", () => {
  it("lists the built-in templates when the repo has none", async () => {
    const r = await list({});
    expect(r.findings).toEqual([]);
    expect(r.templates.map((t) => [t.name, t.source, t.path])).toEqual([
      ["basic", "builtin", null],
      ["lean", "builtin", null],
      ["zeta", "builtin", null],
    ]);
    expect(r.templates[0]).toEqual({
      name: "basic",
      version: 2,
      source: "builtin",
      path: null,
      sections: [
        { id: "done", heading: "Done when", required: true, guidance: "Say when it's done." },
      ],
    });
  });

  it("lists repo templates that pass the lint, sorted by name with the built-ins", async () => {
    const r = await list({
      "docs/x/templates/basic.md": template("basic"),
      "docs/x/templates/mid.md": template("mid"),
      "docs/x/templates/nested/deep.md": template("deep"),
    });
    expect(r.findings).toEqual([]);
    expect(r.templates.map((t) => [t.name, t.source, t.path])).toEqual([
      ["basic", "repo", "docs/x/templates/basic.md"],
      ["lean", "builtin", null],
      ["mid", "repo", "docs/x/templates/mid.md"],
      ["zeta", "builtin", null],
    ]);
  });

  it("leaves out a repo template that fails the lint or doesn't parse, and it shadows its built-in", async () => {
    const r = await list({
      "docs/x/templates/lean.md": template("lean", { doneRequired: false }),
      "docs/x/templates/zeta.md": "no front matter\n",
    });
    expect(r.templates.map((t) => t.name)).toEqual(["basic"]);
    expect(r.findings.map((f) => [f.rule, f.file])).toEqual([
      ["template/frontmatter", "docs/x/templates/zeta.md"],
      ["template/required-section", "docs/x/templates/lean.md"],
    ]);
  });
});
