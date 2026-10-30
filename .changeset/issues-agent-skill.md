---
"@nikovirtala/issues": minor
---

Add the prompts issues_from_discussion and issues_breakdown to `issues mcp`, and `issues init --skill [--skill-dir <path>]`, which writes the agent skill (SKILL.md, by default `.claude/skills/issues/SKILL.md`, never overwritten) and a pointer line in AGENTS.md. The library exports `SKILL_MD`.

Changed behaviour:
- `issues-init/v1`'s `skill` is the SKILL.md path with `--skill`.
