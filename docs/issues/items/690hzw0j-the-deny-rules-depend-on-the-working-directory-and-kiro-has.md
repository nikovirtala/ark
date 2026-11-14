# The deny rules depend on the working directory, and Kiro has none

## Summary
The Claude Code deny rules are written as `Edit(docs/*/events/**)`. A pattern without a leading slash is relative to the current directory, not the project ([permissions](https://code.claude.com/docs/en/permissions)), so a session started in a subdirectory isn't covered; `/docs/…` anchors at the project. Whether `Write(path)` rules are honoured, or `Edit` rules already cover every file-editing tool, isn't confirmed. Kiro keeps permissions per user outside the repository ([configuration](https://kiro.dev/docs/configuration/)), so the setup writes no deny rules for Kiro at all, although a PreToolUse hook can block.

## Steps to reproduce
1. Start Claude Code in `packages/` of a repository with the generated settings.
2. Ask it to edit `../docs/adr/index.md`.
3. Repeat in Kiro from the root.

## Expected
Both refuse the direct edit and say to use the tool.

## Actual
Claude Code allows it from a subdirectory; Kiro allows it anywhere.

## Done when
- Claude Code's rules use `/docs/…` patterns, and the rule set is checked against the current permissions docs for which tools path rules cover.
- Kiro gets a PreToolUse hook on the `write` group that blocks edits to the log paths with a message pointing to the tool.
- The protected paths come from each tool's configured log root, not a fixed `docs/`.
- Tests cover a session from a subdirectory for Claude Code and a blocked write for Kiro.
