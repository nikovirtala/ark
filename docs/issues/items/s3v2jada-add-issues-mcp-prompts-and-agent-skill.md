# Add issues' MCP prompts and agent skill

## Goal
Add the prompts `issues_from_discussion` and `issues_breakdown`, write the agent skill with `issues init --skill`, and bring `docs/02-issues-v1.md` and the issues README up to date. Last of ?4's four pull requests; it closes ?4.

## Notes
- SKILL.md is `docs/02-issues-v1.md`'s block with the corrections the shipped behaviour needs (the close policy, the ?7 scope rule, CLI attribution, searching before filing); a test keeps the two equal.
- The AGENTS.md pointer is one line naming the skill path, as `adr init --skill` writes; ark's own AGENTS.md isn't changed by this issue.
- The pull request also brings `docs/02-issues-v1.md` up to date with the shipped search, MCP surface and skill (dec 8).

## Done when
- `issues mcp` serves the prompts `issues_from_discussion` and `issues_breakdown`.
- `issues init --skill [--skill-dir <path>]` writes SKILL.md (by default `.claude/skills/issues/SKILL.md`) without overwriting an existing one, and adds one pointer line to AGENTS.md; a test keeps SKILL.md equal to the block in `docs/02-issues-v1.md`.
- The issues README documents `issues mcp`, `issues search` and `init --skill` and no longer lists the MCP server as missing.
- Tests cover the prompts and `init --skill`; a changeset records the minor release, so the next version PR releases an issues version with `issues mcp`, `init --skill` and `search`.
- The PR that does this closes the issue in the same change, and closes ?4 in the same change too, with a reason saying how each of ?4's Done when conditions was met.
