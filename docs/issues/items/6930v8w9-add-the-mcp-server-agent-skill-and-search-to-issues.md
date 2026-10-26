# Add the MCP server, agent skill and search to issues

## Problem
Agents can use issues only through the CLI. There is no MCP server, no skill telling an agent when to open, pick up or close an issue, and no `search`. This is the third of the three pull requests that build issues in roadmap step 4 of `docs/00-ark-v1.md`: phase 3, agents, in `docs/02-issues-v1.md` "Implementation notes, roadmap and open questions".

## Proposal
- **`issues mcp`**, on ledger's MCP scaffolding, with the tools, resources (`issues://index`, `issues://issue/{id}`, `issues://ready`) and prompts (`issues_from_discussion`, `issues_breakdown`) of `docs/02-issues-v1.md` "MCP surface". Each tool returns the document its CLI prints under `--json` (ADR-0012). An agent's close follows the log's policy, with `mcp_can_close` and `close_requires_human` refusing it and no reopen tool (ADR-0014).
- **SKILL.md** written by `issues init --skill`, with the one-line pointer in `AGENTS.md`, as in "Agent skill (SKILL.md)".
- **`issues search`** and `issues_search`, open issues only unless asked, across sources under the cache rule of PR 2.
- **State headers** leading every response that includes a description, with the pointer to the canonical issue on a duplicate.

## Alternatives


## Done when
- A released issues version ships `issues mcp`, `init --skill` and `search`, with tests, and the issues README no longer lists the MCP server as missing.
- Every MCP tool's `structuredContent` is the document the CLI prints for the same operation, a refused write is an `ok: false` result and an error is an `ark-error/v1` result, as ADR-0012 says.
- Over MCP, an agent's close is refused when `mcp_can_close = false` or `close_requires_human = true`, an agent's close without a reason is reported as `issue/agent-reason-required`, and no tool reopens an issue.
- `issues_search` and `issues list` over MCP read other sources only from the cache, as `verify` does after PR 2.
- The PR that does this work closes this issue in the same change, with a reason saying how each of these conditions was met.
