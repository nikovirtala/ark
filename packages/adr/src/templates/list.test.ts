import { MemoryTree, NO_NUMBERING } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADR_CONFIG } from "../config.js";
import { readDecisionsFrom } from "../log.js";
import { LAYOUT } from "../test-support/events.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { listTemplates } from "./list.js";

const read = (files: Record<string, string>, defaultTemplate = "nygard") =>
  readDecisionsFrom(new MemoryTree(files), {
    layout: LAYOUT,
    adr: { ...DEFAULT_ADR_CONFIG, defaultTemplate },
    numbering: NO_NUMBERING,
  });

const LITE = `---
template: lite
version: 3
sections:
  - id: decision
    heading: Decision
    required: true
    guidance: What we do.
  - id: scope
    heading: Scope
    required: true
  - id: notes
    heading: Notes
---
# {{title}}

## Decision
{{decision}}

## Scope
{{scope}}

## Notes
{{notes}}
`;

describe("listTemplates", () => {
  it("lists the built-ins by name with their sections", async () => {
    const doc = await listTemplates(await read({}));
    expect(doc).toMatchObject({
      format: "adr-templates/v1",
      root: "docs/adr",
      default: "nygard",
      findings: [],
      notes: [],
    });
    expect(doc.templates.map((t) => [t.name, t.source, t.path])).toEqual([
      ["madr", "builtin", null],
      ["nygard", "builtin", null],
      ["y-statement", "builtin", null],
    ]);
    expect(doc.templates.find((t) => t.name === "nygard")?.sections).toEqual([
      {
        id: "context",
        heading: "Context",
        required: true,
        guidance: "What is the issue that motivates this decision? Describe the forces at play.",
      },
      expect.objectContaining({ id: "decision", required: true }),
      expect.objectContaining({ id: "scope", required: true }),
      expect.objectContaining({ id: "consequences", required: true }),
    ]);
  });

  it("lists repo templates, which shadow built-ins of the same name", async () => {
    const nygard = (BUILTIN_TEMPLATES.nygard ?? "").replace("version: 1", "version: 2");
    const doc = await listTemplates(
      await read(
        {
          "docs/adr/templates/lite.md": LITE,
          "docs/adr/templates/nygard.md": nygard,
        },
        "lite",
      ),
    );
    expect(doc.default).toBe("lite");
    expect(doc.templates.map((t) => [t.name, t.version, t.source, t.path])).toEqual([
      ["lite", 3, "repo", "docs/adr/templates/lite.md"],
      ["madr", 1, "builtin", null],
      ["nygard", 2, "repo", "docs/adr/templates/nygard.md"],
      ["y-statement", 1, "builtin", null],
    ]);
    expect(doc.templates[0]?.sections.map((s) => [s.id, s.required, s.guidance])).toEqual([
      ["decision", true, "What we do."],
      ["scope", true, null],
      ["notes", false, null],
    ]);
  });

  it("leaves out broken templates and reports why", async () => {
    const noScope = LITE.replace("template: lite", "template: noscope").replace(
      "    heading: Scope\n    required: true",
      "    heading: Scope\n    required: false",
    );
    const doc = await listTemplates(
      await read({
        "docs/adr/templates/noscope.md": noScope,
        "docs/adr/templates/madr.md": "not a template\n",
      }),
    );
    expect(doc.templates.map((t) => t.name)).toEqual(["nygard", "y-statement"]);
    expect(doc.findings.map((f) => [f.rule, f.file, f.kind])).toEqual([
      ["template/frontmatter", "docs/adr/templates/madr.md", "decision"],
      ["template/required-section", "docs/adr/templates/noscope.md", "decision"],
    ]);
  });
});
