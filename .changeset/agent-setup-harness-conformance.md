---
"@nikovirtala/ledger": patch
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

Make the agent setup that `init --setup` writes work the way Claude Code and Kiro run it. The 2026-11-14 audit found that none of it did, and that CI passed because the tests only compared bytes with ark's committed files.

- Hook scripts are written and staged as 100755, and both harnesses run them as `sh <script>`, so a checkout that drops the execute bit still works. `doctor` reports a script that isn't executable (gap kind `not-executable`) with the fix, and a rerun of `init --setup` restores the bit.
- An `ARK_ON_BEHALF_OF` that is still an unexpanded `${…}` placeholder counts as unset, so an MCP write attributes to the git identity instead of failing. The note names the setting that fixes it (Kiro: approve the variable under "Mcp Approved Env Vars"). Claude Code's `.mcp.json` passes `${ARK_ON_BEHALF_OF:-}`. `doctor` reports `ARK_ON_BEHALF_OF` per harness, and the READMEs say how to set it in each.
- The before-edit hook hands Claude Code its records as `hookSpecificOutput.additionalContext` JSON, which is the only form Claude Code delivers for `PreToolUse`, covers `Edit`, `Write` and `NotebookEdit`, and says nothing when no record applies. Kiro gets plain stdout on its `write` group.
- Direct edits to the logs are refused from any directory. Claude Code gets `Edit(/…)` deny rules anchored at the project (`Write(path)` rules never match), and Kiro gets a `PreToolUse` hook on `write` that blocks the edit and names the tool. The protected paths follow each tool's configured log root.
- The session-start hook runs one `npm exec` instead of five `npx` calls, and resolves the main ref the way numbering does instead of assuming `origin/main`.

`@nikovirtala/ledger` adds `HARNESS_RUNTIMES`, `claudeRuntime` and `kiroRuntime`, where each harness module declares how it runs a hook, how context must be emitted, how an edit is blocked, and the shape of its configs, plus `runHook`, `installToolStubs` and `repoFiles` in `@nikovirtala/ledger/testing`, so tests run the generated setup the way each harness does. `arkSetup` takes the logs to protect (`arkLogs`), `SetupPiece` can require an executable file, and `runDoctor` reports `environment` and the `not-executable` kind.
