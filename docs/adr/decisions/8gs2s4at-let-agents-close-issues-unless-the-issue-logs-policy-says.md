# Let agents close issues unless the issue log's policy says otherwise

## Context
Closing an issue is cheap to undo, because a closed issue can be reopened. Accepting a decision is not cheap to undo, which is why agents propose decisions and people accept them (ADR-0007, ADR-0013). adr's `mcp_can_decide` is applied only by the MCP server (ADR-0013). Agents that do the work tracked in an issue need to say when it is finished, and the issue log's checks already name a close policy for agents.

## Decision
An agent may close an issue it has finished. It must give a reason saying how the issue's Done when conditions were met, and the closed event is reviewed with the change that does the work. An agent's `closed` event without a reason is reported as `issue/agent-reason-required`. `issues.toml` has two `[policy]` keys, `mcp_can_close` (default `true`) and `close_requires_human` (default `false`). When `mcp_can_close = false` or `close_requires_human = true`, the CLI and the MCP server refuse an agent's `closed` event, and `verify` reports it as `issue/agent-closed`. Unlike `mcp_can_decide`, `mcp_can_close` is a rule of the issue log, because the log's checks name it. Agents cannot reopen issues: the MCP surface has no reopen tool, and reopening is left to people.

## Scope
issues' close policy: the issue kind's agent-close rules and the `[policy]` keys of `issues.toml`.

## Consequences
Agents finish issues without a human step, and the closed event is reviewed with the change that does the work. A repository that wants a human to close issues sets either key. Because `verify` checks every applied `closed` event, a full `verify` after the policy changes also reports earlier agent closes.
