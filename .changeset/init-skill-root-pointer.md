---
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`adr init --skill` and `issues init --skill` add their `AGENTS.md` pointer when `--skill-dir` is the repository root and the other tool's pointer is already there. A line counts as naming the skill only when it holds the skill's path as a whole path, optionally after `./`, not as the end of a longer path: adr's `.claude/skills/adr/SKILL.md` no longer counts as naming `SKILL.md`.

Changed behaviour:
- A line that holds the skill's path only inside a longer path or URL, such as `foo/.claude/skills/issues/SKILL.md` or `SKILL.md.bak`, no longer keeps the pointer from being added.
