# Add init --skill's AGENTS.md pointer when the skill sits at the repository root

## Goal
Make `issues init --skill` and `adr init --skill` add their AGENTS.md pointer when `--skill-dir` is the repository root and the other tool's pointer is already there.

## Notes
Review finding F2 (LOW) of #52 (?16, issues PR 3d), deferred under decision 6.

- With `--skill-dir .` the skill path is `SKILL.md`. The AGENTS.md check in `packages/issues/src/init.ts`, `(text ?? "").split("\n").some((l) => l.includes(skill))`, then matches adr's pointer line, which names `.claude/skills/adr/SKILL.md`, so issues' pointer is never added.
- `packages/adr/src/init.ts` has the same rule (adr design D7) and the same gap the other way round; 3d copied the rule on purpose.
- The default path and subdirectory paths work.
- Suggested fix: match the skill path as a whole path token, not as the suffix of a longer path, or match the exact pointer line, in both tools.

## Done when
- `issues init --skill --skill-dir .` adds its pointer line to an AGENTS.md that already has adr's pointer, and `adr init --skill --skill-dir .` does the same next to issues' pointer.
- A line that already names the same skill path still keeps the pointer from being added twice.
- Tests in both packages cover a root-level `--skill-dir` next to the other tool's pointer.
