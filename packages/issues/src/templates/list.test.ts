import { MemoryTree, NO_NUMBERING } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { DEFAULT_ISSUES_CONFIG } from "../config.js";
import { readIssuesFrom, readNotes } from "../log.js";
import { LAYOUT } from "../test-support/events.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { listTemplates } from "./list.js";

const read = (files: Record<string, string>, defaultTemplate = "task") =>
  readIssuesFrom(new MemoryTree(files), {
    layout: LAYOUT,
    issues: { ...DEFAULT_ISSUES_CONFIG, defaultTemplate },
    numbering: NO_NUMBERING,
    sources: null,
  });

const CHORE = `---
template: chore
version: 3
sections:
  - id: what
    heading: What
    required: true
    guidance: The chore.
  - id: notes
    heading: Notes
  - id: done
    heading: Done when
    required: true
---
# {{title}}

## What
{{what}}

## Notes
{{notes}}

## Done when
{{done}}
`;

describe("listTemplates", () => {
  it("lists the built-ins by name with their sections", async () => {
    const r = await read({});
    const doc = await listTemplates(r);
    expect(doc).toMatchObject({
      format: "issues-templates/v1",
      root: "docs/issues",
      default: "task",
      findings: [],
      notes: readNotes(r),
    });
    expect(doc.templates.map((t) => [t.name, t.source, t.path])).toEqual([
      ["bug", "builtin", null],
      ["feature", "builtin", null],
      ["task", "builtin", null],
    ]);
    expect(doc.templates.find((t) => t.name === "task")?.sections).toEqual([
      {
        id: "goal",
        heading: "Goal",
        required: true,
        guidance: "What this task changes, in a sentence or two.",
      },
      expect.objectContaining({ id: "notes", required: false }),
      {
        id: "done",
        heading: "Done when",
        required: true,
        guidance: "Observable conditions that make this issue finished.",
      },
    ]);
  });

  it("lists repo templates, which shadow built-ins of the same name", async () => {
    const task = (BUILTIN_TEMPLATES.task ?? "").replace("version: 1", "version: 2");
    const doc = await listTemplates(
      await read(
        {
          "docs/issues/templates/chore.md": CHORE,
          "docs/issues/templates/task.md": task,
        },
        "chore",
      ),
    );
    expect(doc.default).toBe("chore");
    expect(doc.templates.map((t) => [t.name, t.version, t.source, t.path])).toEqual([
      ["bug", 1, "builtin", null],
      ["chore", 3, "repo", "docs/issues/templates/chore.md"],
      ["feature", 1, "builtin", null],
      ["task", 2, "repo", "docs/issues/templates/task.md"],
    ]);
    expect(doc.templates[1]?.sections.map((s) => [s.id, s.required, s.guidance])).toEqual([
      ["what", true, "The chore."],
      ["notes", false, null],
      ["done", true, null],
    ]);
  });

  it("leaves out broken templates, which also hide the built-in of their name", async () => {
    const noDone = CHORE.replace("template: chore", "template: nodone").replace(
      "    heading: Done when\n    required: true",
      "    heading: Done when\n    required: false",
    );
    const doc = await listTemplates(
      await read({
        "docs/issues/templates/nodone.md": noDone,
        "docs/issues/templates/bug.md": "not a template\n",
      }),
    );
    expect(doc.templates.map((t) => t.name)).toEqual(["feature", "task"]);
    expect(doc.findings.map((f) => [f.rule, f.file, f.kind])).toEqual([
      ["template/frontmatter", "docs/issues/templates/bug.md", "issue"],
      ["template/required-section", "docs/issues/templates/nodone.md", "issue"],
    ]);
  });
});
