# Attribute agent writes with ARK_AGENT and ARK_ON_BEHALF_OF

## Context
Every event records who wrote it in the envelope's `actor`: `kind` human or agent, `name`, `email`, `agent` and `on_behalf_of` (ADR-0003, [adr: Event schema](../../01-adr-v1.md#event-schema)). Agents write logs through the CLI as well as through the planned MCP server, and adr's policy is that agents propose and humans decide (`accept_requires_human`, [adr: Repository layout](../../01-adr-v1.md#repository-layout)). In adr 0.1.0 an agent's `on_behalf_of` could only come from the git author identity, so naming the person meant setting `GIT_AUTHOR_*`, which also changes the author of `--commit` commits.

## Decision
An agent using an ark CLI sets `ARK_AGENT=<agent-id>`, and `ARK_ON_BEHALF_OF=<email>` for the person it acts for. Its events get an `agent` actor on behalf of that address. Without `ARK_ON_BEHALF_OF`, `on_behalf_of` is the git author identity's email, and every write says so in a note on stderr and in the JSON `notes`. An `ARK_ON_BEHALF_OF` that isn't an email address is a config error: the command exits 2 before anything is written. `ARK_ON_BEHALF_OF` without `ARK_AGENT` is ignored, with a note. Without `ARK_AGENT`, events are recorded as the git user ([Monorepo](../../00-ark-v1.md#monorepo), Shared conventions).

ledger's Surfaces layer resolves the actor (`resolveAttribution` in `packages/ledger/src/surfaces/actor.ts`), so every ledger-based tool behaves the same. There is no config key and no command-line flag for it, because who an agent acts for belongs to the session, not to the repository.

Agents may propose but not accept. With `accept_requires_human` on (the default), `adr accept` refuses an agent with exit 1, `adr verify` reports an acceptance written by an agent (`decision/agent-accepted`), and `adr new` tells an agent to ask a human to review and accept. The CLI doesn't otherwise restrict agents; the MCP server's policies, such as `mcp_can_decide`, come in phase 3 ([adr: MCP surface](../../01-adr-v1.md#mcp-surface)).

## Scope
How every ledger-based tool attributes the events it writes: actor resolution in ledger's Surfaces layer, adr's acceptance policy and its check in `verify`, and the adr writes and commands that record actors and print the attribution notes.

## Consequences
- An agent can name the person it acts for without changing the author of the commits it makes.
- A forgotten `ARK_ON_BEHALF_OF` still produces an attributed event, and the note on every write makes the fallback visible.
- An agent can't accept its own proposals while `accept_requires_human` is on, and an acceptance written around the CLI fails `adr verify`.
- `ARK_AGENT` and `ARK_ON_BEHALF_OF` are claims, not authentication: anyone who can set them can write any attribution, and reviewers and the git history are what catch misuse.
