import { lintDocument, lintTemplate, parseTemplate, renderTemplate } from "@nikovirtala/ledger";
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "./builtin.js";

describe("built-in templates", () => {
  it("are nygard, madr and y-statement", () => {
    expect(Object.keys(BUILTIN_TEMPLATES).sort()).toEqual(["madr", "nygard", "y-statement"]);
  });

  for (const [name, text] of Object.entries(BUILTIN_TEMPLATES)) {
    describe(name, () => {
      const parsed = parseTemplate(text, { path: `docs/adr/templates/${name}.md` });
      if (!parsed.ok) throw new Error(`${name} does not parse: ${JSON.stringify(parsed.findings)}`);
      const t = parsed.template;

      it("parses as version 1 and lints clean with a required scope section", () => {
        expect(parsed.findings).toEqual([]);
        expect(t.name).toBe(name);
        expect(t.version).toBe(1);
        expect(lintTemplate(t, { requireSections: ["scope"] })).toEqual([]);
        expect(t.sections.find((s) => s.id === "scope")?.required).toBe(true);
      });

      it("gives every section guidance, so an unfilled draft fails its lint", () => {
        expect(t.sections.every((s) => (s.guidance ?? "").trim() !== "")).toBe(true);
        const draft = renderTemplate(
          t,
          { title: "Use Aurora", sections: {} },
          { missing: "guidance" },
        );
        if (!draft.ok) throw new Error("render failed");
        const required = t.sections.filter((s) => s.required).length;
        expect(lintDocument(t, draft.text).map((f) => f.rule)).toEqual(
          t.sections.map(() => "template/guidance-left"),
        );
        expect(required).toBeGreaterThan(0);
      });

      it("lints clean once every section is filled in", () => {
        const sections = Object.fromEntries(t.sections.map((s) => [s.id, `Our ${s.id}.`]));
        const doc = renderTemplate(t, { title: "Use Aurora", sections });
        if (!doc.ok) throw new Error("render failed");
        expect(lintDocument(t, doc.text)).toEqual([]);
      });
    });
  }
});
