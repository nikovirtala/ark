# Release through next and run other repositories' tools from latest

## Context
`release.yml` publishes every changed package with Changesets and npm trusted publishing on each push to `main`, straight to `latest`. Repositories other than ark pin an exact version in their MCP configuration (R4 and R10 of the agent setup design, docs/03-setup-v1.md), so a fix reaches them only when someone bumps the pin in a pull request in each repository.

The factory design (docs/04-factory-v1.md) wants a papercut an agent hits in an ark tool fixed and in use before a second agent hits it, within the length of one agent task (hours). A bump pull request per consuming repository cannot meet that. Kiro cloud sessions start in fresh sandboxes, so a session that runs a channel resolves it at start.

A channel that spreads a fix in hours spreads a bad release just as fast, so it needs a gate between publishing and use. Since 30 September 2026 npm trusted publishing can be given an opt-in permission to manage dist-tags with OIDC, independent of the permission to publish. npx can keep serving a cached version after a tag moves, and npm can pick an older release when Node is older than a package's `engines` field.

## Decision
We will release through two channels and run other repositories' tools from the stable one.

- **Publish to `next`.** `release.yml` publishes with `--tag next`. It keeps the publish permission and gains no other.
- **Promote to `latest`.** A separate `promote.yml` moves `latest` to a version on `next` after the factory's promotion checks pass, and moves it back on rollback. Its trusted publisher configuration may manage dist-tags and may not publish, so the job that moves tags cannot publish and the job that publishes cannot promote.
- **Consumers run `latest`.** `init --setup` in a repository other than ark writes each MCP server as `npx -y --prefer-online @nikovirtala/<tool>@latest mcp`, so npx checks the registry rather than trusting its cache.
- **Servers check themselves.** At start each server compares its own version with `latest` and, when behind, says so in its tool responses.
- **ark keeps exact pins.** ark's own tooling still runs the previous release, bumped in a pull request (ADR-0017).

## Scope
The release workflow (`.github/workflows/release.yml`), a new promote workflow (`.github/workflows/promote.yml`, added to this decision's globs when it exists), the MCP server entries `init --setup` writes for repositories other than ark, and the version check at server start. For repositories other than ark it replaces R4 ("MCP configs MUST pin an exact version") and the exact-pin part of R10 of the agent setup design. It does not change how ark pins its own tooling (ADR-0017). The promotion checks themselves are described in the factory design.

## Consequences
Easier: a promoted fix reaches every new cloud session with no pull request in the consuming repository; a rollback is a tag move that takes seconds; publishing and promoting are held by separate identities.

Harder: two sessions can run different versions on the same day, so reports must record the version that ran, and event formats must stay compatible with versions running side by side. The exact tool version a session ran can no longer be read from the repository. A second workflow and a second trusted publisher configuration must be maintained.

Risk: a bad release reaches every new session at once; the promotion gate and the circuit breaker in the factory design exist to stop it. Outside fresh sandboxes npx may still serve a stale version; `--prefer-online` and the self-check reduce this, and whether `--prefer-online` re-resolves `latest` in a local Claude Code session is still to be verified.
