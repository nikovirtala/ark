# Say once that on_behalf_of came from the git identity

## Problem
Every write by an agent without `ARK_ON_BEHALF_OF` prints `on_behalf_of taken from the git identity`. The warning is right, but a batch of writes repeats it each time, so it reads as noise and stops being noticed.

## Proposal
Warn once, where the setting can be fixed. The MCP server warns at start; the CLI warns once per clone until the value changes; doctor reports it; and the agent setup passes `ARK_ON_BEHALF_OF` through, so the warning appears only when something is missing.

## Done when
- The MCP servers print the warning once, at start.
- The CLI prints it the first time in a clone, and again only when the git identity it falls back to changes, keeping its state in the git directory.
- The warning says how to set `ARK_ON_BEHALF_OF`, in the agent's MCP config or the shell, and why it matters: it names who an agent's events were written for.
- doctor (?60) reports a missing `ARK_ON_BEHALF_OF` with the same advice.
- The README's attribution section shows both ways to set it.
