# Report missing or outdated agent setup with a doctor command

## Goal
Add a doctor command, shared through ledger, that reports what is missing or out of date in a repository's and a clone's agent setup, so a gap is noticed instead of passing every check.

## Notes
verify checks the logs, not the integration, so a repository with perfect logs and no agent wiring passes. Doctor checks the pieces init writes: git hooks in this clone, MCP configs and their pinned versions against the installed tools, skills older than the tool, missing harness hooks and permission rules. See the agent setup design (docs/03-setup-v1.md).

It runs in the session-start hook, so an agent learns at the start of every session that its own wiring is incomplete, and in CI as a warning.

## Done when
- doctor lists every missing or outdated piece with the command that fixes it, and exits 1 when something is missing.
- The session-start hook runs it and installs missing git hooks in the clone, or says why it can't.
- CI runs it as a warning in ark.
