import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SKILL_MD } from "./skill.js";

// D8: the shipped skill is 01's "Agent skill (SKILL.md)" block, so the two can't drift.
it("equals the skill block in docs/01-adr-v1.md", () => {
  const doc = readFileSync(new URL("../../../docs/01-adr-v1.md", import.meta.url), "utf8");
  const section = doc.indexOf("## Agent skill (SKILL.md)");
  expect(section).toBeGreaterThan(0);
  const start = doc.indexOf("```markdown\n", section) + "```markdown\n".length;
  const end = doc.indexOf("\n```\n", start) + 1;
  expect(SKILL_MD).toBe(doc.slice(start, end));
  expect(SKILL_MD.startsWith("---\nname: adr\n")).toBe(true);
});
