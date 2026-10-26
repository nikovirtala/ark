# Gate agents' deciding and rescoping behind mcp_can_decide

## Context
adr's policy is that agents propose and humans decide. ADR-0007 records how agent writes are attributed and that `accept_requires_human` keeps agents from accepting, and leaves the MCP server's own policies, such as `mcp_can_decide`, to the server ([adr: MCP surface](../../01-adr-v1.md#mcp-surface)). Every write over MCP is an agent's, on behalf of `ARK_ON_BEHALF_OF` or the git identity. Some of those writes decide things without being an acceptance: rejecting or deprecating a decision, superseding it, editing or withdrawing another person's proposal, or narrowing the scope of an accepted decision, which can switch it off for the code it governed. Repositories differ in how far they trust agents with those.

## Decision
Over MCP, agents propose, note, link and read, and edit, scope or withdraw the proposals they own. Deciding needs `[policy] mcp_can_decide = true` in `adr.toml` (default `false`). A proposal is the agent's own when it is still proposed and its `proposed` event was written on behalf of the same person the agent acts for (`on_behalf_of`, or a human's `email`, compared case-insensitively).

| Over MCP | `mcp_can_decide = false` | `true` |
| --- | --- | --- |
| read, search, propose, note, link | allowed | allowed |
| edit, scope or withdraw an own proposal | allowed | allowed |
| edit, scope or withdraw another person's proposal; scope an accepted or deprecated decision | refused, `decision/mcp-cannot-decide` | allowed |
| reject, deprecate, supersede | tools not listed | allowed |
| accept | tool not listed | allowed only with `accept_requires_human = false` |

`accept_requires_human` still applies: while it is on (the default), `adr_accept` refuses agents with `decision/agent-accepted`, and `adr mcp` warns at startup when both keys are on. A write the state machine forbids gets the state machine's refusal whatever the policy. The tool list is fixed when the server starts, so changing `mcp_can_decide` takes a restart, and a decision tool called after the key was turned off is refused with a usage error saying so.

The rule lives in adr's MCP server (`packages/adr/src/mcp/policy.ts`), not in its library, so the CLI keeps restricting agents only through `accept_requires_human`. This refines ADR-0007 and leaves it unchanged.

## Scope
Which tools adr's MCP server lists and which of their writes it refuses: the `[policy] mcp_can_decide` key in adr's config, the ownership and refusal rules in adr's MCP policy module, and the MCP tools that call them.

## Consequences
- By default an agent can draft, refine and withdraw its own proposals over MCP, and deciding or rescoping accepted decisions goes through the CLI.
- A repository can let agents reject, deprecate, supersede and rescope with one key, and needs a second key before they can accept.
- An agent can't edit, rescope or withdraw another person's proposal without `mcp_can_decide`, so it adds a note instead.
- Ownership rests on `ARK_ON_BEHALF_OF`, which is a claim (ADR-0007): an agent that sets someone else's address can edit that person's proposals, and reviewers and the git history catch it.
- A tool whose kind separates proposing from deciding can follow the same split behind its own `mcp_can_decide`.
