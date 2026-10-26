import {
  extractSections,
  lintDocument,
  lintTemplate,
  parseTemplate,
  renderTemplate,
  replaceSections,
  type Template,
} from "@nikovirtala/ledger";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { issueKind } from "../kind.js";
import { BUILTIN_TEMPLATES, builtinTemplate, TASK_V1 } from "./builtin.js";

function parsed(name: string): Template {
  const r = parseTemplate(BUILTIN_TEMPLATES[name] ?? "", {
    path: `docs/issues/templates/${name}.md`,
  });
  if (!r.ok) throw new Error(`${name}: ${r.findings.map((f) => f.message).join("; ")}`);
  return r.template;
}

describe("built-in templates", () => {
  it("are bug, feature and task, and task is TASK_V1", () => {
    expect(Object.keys(BUILTIN_TEMPLATES).sort()).toEqual(["bug", "feature", "task"]);
    expect(builtinTemplate("task")).toBe(TASK_V1);
    expect(builtinTemplate("nope")).toBeNull();
    expect(builtinTemplate("constructor")).toBeNull();
  });

  for (const name of ["bug", "feature", "task"]) {
    it(`${name} parses, is version 1 and passes template lint with a required done section`, () => {
      const t = parsed(name);
      expect(t.name).toBe(name);
      expect(t.version).toBe(1);
      expect(
        lintTemplate(t, { requireSections: issueKind.def.templates?.requireSections ?? [] }),
      ).toEqual([]);
      expect(t.sections.find((s) => s.id === "done")).toMatchObject({
        heading: "Done when",
        required: true,
      });
    });

    it(`${name} renders a document that lints clean once every section is filled`, () => {
      const t = parsed(name);
      const sections = Object.fromEntries(t.sections.map((s) => [s.id, `Some ${s.id}.`]));
      const r = renderTemplate(t, { title: "Fix it", sections });
      if (!r.ok) throw new Error("render failed");
      expect(lintDocument(t, r.text)).toEqual([]);
      const draft = renderTemplate(t, { title: "Fix it", sections: {} }, { missing: "guidance" });
      if (!draft.ok) throw new Error("render failed");
      expect(lintDocument(t, draft.text).length).toBeGreaterThan(0);
    });
  }

  it("has the sections of the design", () => {
    const ids = (name: string) => parsed(name).sections.map((s) => [s.id, s.required]);
    expect(ids("bug")).toEqual([
      ["summary", true],
      ["reproduce", true],
      ["expected", true],
      ["actual", true],
      ["done", true],
    ]);
    expect(ids("feature")).toEqual([
      ["problem", true],
      ["proposal", true],
      ["alternatives", false],
      ["done", true],
    ]);
    expect(ids("task")).toEqual([
      ["goal", true],
      ["notes", false],
      ["done", true],
    ]);
  });
});

/** Section text without heading lines: words and newlines, trimmed. */
const arbSection = fc
  .array(fc.stringMatching(/^[a-z][a-z ]{0,30}$/), { minLength: 1, maxLength: 3 })
  .map((lines) => lines.map((l) => l.trim()).join("\n"))
  .filter((s) => s.trim() !== "");

describe("round trips (property)", () => {
  for (const name of ["bug", "feature", "task"]) {
    it(`${name}: renderTemplate then extractSections returns the sections`, () => {
      const t = parsed(name);
      fc.assert(
        fc.property(fc.tuple(...t.sections.map(() => arbSection)), (texts) => {
          const sections = Object.fromEntries(t.sections.map((s, i) => [s.id, texts[i] ?? ""]));
          const r = renderTemplate(t, { title: "A title", sections });
          if (!r.ok) return false;
          const x = extractSections(t, r.text);
          expect(x.title).toBe("A title");
          expect(x.missing).toEqual([]);
          expect(x.sections).toEqual(sections);
          return true;
        }),
        { numRuns: 100 },
      );
    });

    it(`${name}: replaceSections changes one section and keeps the others byte for byte`, () => {
      const t = parsed(name);
      fc.assert(
        fc.property(
          fc.tuple(...t.sections.map(() => arbSection)),
          fc.nat({ max: t.sections.length - 1 }),
          arbSection,
          (texts, which, replacement) => {
            const sections = Object.fromEntries(t.sections.map((s, i) => [s.id, texts[i] ?? ""]));
            const r = renderTemplate(t, { title: "A title", sections });
            if (!r.ok) return false;
            const id = t.sections[which]?.id ?? "";
            const next = replaceSections(t, r.text, { [id]: replacement });
            if (!next.ok) return false;
            const x = extractSections(t, next.text);
            expect(x.sections[id]).toBe(replacement);
            for (const s of t.sections) {
              if (s.id !== id) expect(x.sections[s.id]).toBe(sections[s.id]);
            }
            const head = r.text.split(`## ${t.sections[which]?.heading}`)[0];
            expect(next.text.startsWith(head ?? "")).toBe(true);
            return true;
          },
        ),
        { numRuns: 100 },
      );
    });
  }
});
