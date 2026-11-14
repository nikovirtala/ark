# Confirm Kiro's hook events and the approved-variable setting in a real session

## Goal
Check in a real Kiro session what the docs leave open about the setup's hooks and MCP env, and fix the setup where it differs.

## Notes
docs/03-setup-v1.md "Harness formats" lists what no page settles: the tool names and tool_input fields of Kiro's V3 write tools (the hooks read file_path, notebook_path, path or filePath and match the write group), what a PreToolUse hook that exits with a code other than 2 does, whether an unapproved MCP variable arrives as the literal ${VAR}, and where Kiro stores "Mcp Approved Env Vars", which doctor could read to report an unapproved ARK_ON_BEHALF_OF instead of reminding. The harness-run tests use the documented events, so they cannot see a difference between those and a real session.

## Done when
- A real Kiro session shows the before-edit context in the transcript and the protect-logs hook blocking a write to docs/adr/index.md with its message.
- The fixture events in setup-kiro.ts match the events Kiro sends, or the module and docs/03-setup-v1.md say how they differ.
- doctor reports an unapproved ARK_ON_BEHALF_OF for Kiro when the setting can be read, or the design says it cannot.
