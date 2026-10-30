import { describe, expect, it } from "vitest";
import { namesSkill } from "./init.js";

describe("namesSkill", () => {
  const ISSUES_POINTER =
    "Issues in this repository are tracked with issues: read .claude/skills/issues/SKILL.md before starting, continuing or finishing work, and follow it.";
  it.each<[string, string, boolean]>([
    ["read SKILL.md first", "SKILL.md", true],
    ["`SKILL.md`", "SKILL.md", true],
    ["(./SKILL.md)", "SKILL.md", true],
    ["See SKILL.md.", "SKILL.md", true],
    ["SKILL.md\r", "SKILL.md", true],
    ["# Agents\n\nread SKILL.md\n", "SKILL.md", true],
    [ISSUES_POINTER, "SKILL.md", false],
    ["../SKILL.md", "SKILL.md", false],
    ["x./SKILL.md", "SKILL.md", false],
    ["MY-SKILL.md", "SKILL.md", false],
    ["SKILL.md.bak", "SKILL.md", false],
    ["SKILL.mdx", "SKILL.md", false],
    [ISSUES_POINTER, ".claude/skills/issues/SKILL.md", true],
    ["see foo/.claude/skills/adr/SKILL.md", ".claude/skills/adr/SKILL.md", false],
    ["read c++ (x)/SKILL.md", "c++ (x)/SKILL.md", true],
    ["", "SKILL.md", false],
  ])("%j names %j: %s", (text, skill, expected) => {
    expect(namesSkill(text, skill)).toBe(expected);
  });
});
