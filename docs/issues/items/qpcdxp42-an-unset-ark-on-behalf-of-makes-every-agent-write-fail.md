# An unset ARK_ON_BEHALF_OF makes every agent write fail

## Summary
The MCP configs pass `"ARK_ON_BEHALF_OF": "${ARK_ON_BEHALF_OF}"`. Claude Code leaves an unset variable as the literal text `${ARK_ON_BEHALF_OF}` ([MCP docs](https://code.claude.com/docs/en/mcp)), and Kiro expands a variable only after the person approves it under "Mcp Approved Env Vars" ([Kiro MCP configuration](https://kiro.dev/docs/mcp/configuration/)). ledger then rejects the literal as "not an email address", so with the variable unset or unapproved, every write through MCP fails. ark's own `.mcp.json` and `.kiro/settings/mcp.json` have the same line.

## Steps to reproduce
1. Unset `ARK_ON_BEHALF_OF` and start Claude Code in a repository with the generated `.mcp.json`.
2. Ask the agent to propose a decision through `adr_propose`.

## Expected
The write succeeds, attributed to the agent for the git identity's email with the usual note, as when the variable is unset in a shell.

## Actual
The tool refuses: `ARK_ON_BEHALF_OF "${ARK_ON_BEHALF_OF}" is not an email address`.

## Done when
- Claude Code's config uses `${ARK_ON_BEHALF_OF:-}`, so an unset variable arrives empty and falls back to the git identity.
- ledger treats a value that is still an unexpanded `${…}` placeholder as unset, with a note that names the harness setting that fixes it (Kiro: approve the variable under "Mcp Approved Env Vars").
- doctor reports an unapproved or unset `ARK_ON_BEHALF_OF` per harness.
- The README's setup section says how to set the variable for each harness, including Kiro's approval step.
- Tests start the MCP server with the variable unset, empty, and as the literal placeholder.
