# ark documentation

This directory holds ark's design docs and its live decision and work logs. Read this page first, then follow the reading order below.

## Read this first, then this

Follow this path from the top. Each step builds on the one before it.

1. [What ark is and why](00-ark-v1.md) (explanation). Read this first: the problem ark solves, the mechanism-vs-meaning split between ledger and its kinds, the monorepo layout, and the roadmap.
2. [The adr tool](01-adr-v1.md) (explanation). How the decision kind models architecture decisions as frozen bodies plus an append-only event log.
3. [The issues tool](02-issues-v1.md) (explanation). How the issue kind models work as living bodies plus an event log, and how it links to accepted decisions.
4. [Agent setup](03-setup-v1.md) (explanation). How a repository wires the tools for coding agents: MCP servers, skills, hooks and permission rules.
5. [The deployment member](04-deployment-v1.md) (explanation). How a project's pipeline deploys, checks, runs its one-off tasks and freezes itself on a failure, and what agents may do with it.
6. [Factory](05-factory-v1.md) (explanation). How ark works its own issues: papercuts agents hit are fixed and in use before a second agent hits them, the ready backlog drains in between, and Niko reviews only changes to the frame.

## Use the tools

Each package README is the usage reference for its tool. Reach for these when you want commands, flags and configuration rather than rationale.

- [adr README](../packages/adr/README.md) (reference and how-to). Install, commands, config, MCP server and library for the decision tool.
- [issues README](../packages/issues/README.md) (reference and how-to). Install, commands, config, MCP server and library for the issue tool.
- [ledger README](../packages/ledger/README.md) (reference). The shared core library that adr and issues are built on; internal at 0.x.

## Read the live logs

ark records its own decisions and work with its own tools. These logs are the running history, not design docs.

- [Decision log](adr/) (reference). ark's architecture decisions. List them with `node packages/adr/dist/cli.js list` from the repository root.
- [Issue log](issues/) (reference). ark's open and closed work. List it with `node packages/issues/dist/cli.js list`.

## Map the architecture

For a short codemap with the key invariants and pointers back into these docs, read [ARCHITECTURE.md](../ARCHITECTURE.md) at the repository root.
