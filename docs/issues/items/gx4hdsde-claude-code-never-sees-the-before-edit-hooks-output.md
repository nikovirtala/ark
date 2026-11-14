# Claude Code never sees the before-edit hook's output

## Summary
The before-edit hook prints `adr for` and `issues for` as plain text. For PreToolUse, Claude Code writes plain stdout to the debug log only; context reaches Claude only as JSON with `hookSpecificOutput.additionalContext` ([hooks reference](https://code.claude.com/docs/en/hooks)). Kiro's docs don't say what happens to a PreToolUse command's stdout ([hook types](https://kiro.dev/docs/hooks/types/)). The hook that should show the governing records before an edit shows nothing.

## Steps to reproduce
1. In a repository with an accepted decision scoped to `src/**`, start Claude Code with the generated setup (and executable scripts).
2. Ask it to edit a file under `src/`.

## Expected
Before the edit, Claude receives the decision as context.

## Actual
The output goes to the debug log, and Claude edits without seeing it.

## Done when
- The Claude Code hook emits `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": …}}`, and emits nothing when no record applies.
- Kiro's behaviour is checked against its current docs or a real session, and the Kiro hook uses whatever reaches the agent; the finding is written in the design doc.
- The hook covers every file-editing tool each harness has (Claude Code: `Edit`, `Write`, `NotebookEdit`; Kiro: the `write` group).
- The harness-run test from the hook-script bug checks the output format, not only the exit code.
