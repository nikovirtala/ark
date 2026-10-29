---
"@nikovirtala/issues": minor
---

Add the write tools to `issues mcp`: issues_open, issues_update, issues_comment, issues_start, issues_stop, issues_close, issues_link, issues_unlink, issues_label, issues_assign and issues_scope. Writes are recorded as the MCP client's agent, on behalf of `ARK_ON_BEHALF_OF` (else the git user, with a note), stage their files and commit only with `[policy] auto_commit`. issues_close is listed only when `[policy] mcp_can_close = true`; with `close_requires_human = true` it refuses agents (`issue/agent-closed`), and an agent's close needs a reason (`issue/agent-reason-required`). There is no reopen tool: reopening is left to people. issues_update refuses a description with unstaged changes.

Changed behaviour:
- `planEdit` and `editIssue` take `refuseIncomplete`: when set and the write commits, a description that fails template lint is refused instead of committed. The CLI doesn't set it.
