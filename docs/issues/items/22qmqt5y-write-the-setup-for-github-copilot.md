# Write the setup for GitHub Copilot

## Problem
The setup writes for Claude Code and Kiro only. GitHub Copilot reads a repository's root `.mcp.json` (VS Code and the CLI), skills in `.github/skills/<name>/SKILL.md`, and hooks in `.github/hooks/*.json` (the CLI and the cloud agent: `sessionStart` can add context, `preToolUse` can deny a tool call). The CLI also runs the hooks in `.claude/settings.json`, so writing both naively runs ark's hooks twice.

## Proposal
Add Copilot as a harness module: skills under `.github/skills`, a `.github/hooks/<tool>.json` with `sessionStart` and `preToolUse` hooks, the deny rules as a `preToolUse` hook, and the shared root `.mcp.json`. Check each format against GitHub's current docs when implementing.

## Done when
- With Copilot chosen, init writes `.github/skills/<tool>/SKILL.md` and `.github/hooks/<tool>.json` (version 1, `sessionStart` adding the session context, `preToolUse` reporting governing records before an edit and denying direct edits to `docs/*/events/**`, `docs/*/index.md` and decision bodies), and `.mcp.json` with `ARK_AGENT` naming Copilot.
- With Claude Code and Copilot both chosen, no hook runs twice in the Copilot CLI; a test covers it.
- The cloud agent's MCP servers can't be written from a file: `init` prints the repository setting to add, and doctor reports it until it's there ("can't check" when it can't see repository settings).
- The README's setup table has a Copilot column, sourced from GitHub's docs, and says what Copilot code review reads.
- R11's fixture repositories include one with Copilot chosen.
