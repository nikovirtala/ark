---
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`adr init --skill --skill-dir .` and `issues init --skill --skill-dir .` add their AGENTS.md pointer next to the other tool's pointer. A line now keeps the pointer from being added only when it names the skill path as a whole path, not as the end of a longer one such as `.claude/skills/adr/SKILL.md`.
