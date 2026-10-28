# Add the write side of issues mcp

## Goal
Add the write tools of `docs/02-issues-v1.md` "MCP surface" to `issues mcp`, with agent attribution and the close policy of ADR-0014. Third of ?4's four pull requests.

## Notes
- The issue kind already refuses agent closes under `close_requires_human` and `mcp_can_close = false`; the server only leaves `issues_close` out of its list when `mcp_can_close = false` at startup.
- `issues_update` refuses a description with unstaged changes, and with `auto_commit` an incomplete description is refused instead of committed.
- Don't start the issue before its scope's files are committed (?7).

## Done when
- `issues mcp` adds `issues_open`, `issues_update`, `issues_comment`, `issues_start`, `issues_stop`, `issues_close`, `issues_link`, `issues_unlink`, `issues_label`, `issues_assign` and `issues_scope`, whose events record the MCP client's name as the agent, on behalf of `ARK_ON_BEHALF_OF`, or else the git user with a note.
- Each write tool's `structuredContent` is the `issues-write/v1` document the CLI prints for the same write; a write the log's rules refuse is an `ok: false` result with the findings, and an error is an `ark-error/v1` result.
- Over MCP an agent's close is refused when `mcp_can_close = false` (`issues_close` isn't listed and a call gets an error naming the key; a key turned off while the server runs gives `issue/agent-closed`) or `close_requires_human = true` (`issue/agent-closed`); a close without a reason is reported as `issue/agent-reason-required`; no tool reopens an issue, and a call to `issues_reopen` gets an error saying reopening is left to people.
- Unit tests and the stdio end-to-end test cover every write tool and both policy keys; the issues README documents the write tools and the close policy; a changeset records the minor release.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
