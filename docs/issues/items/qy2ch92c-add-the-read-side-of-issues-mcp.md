# Add the read side of issues mcp

## Goal
Add `issues mcp` with the read tools, resources and state headers of `docs/02-issues-v1.md` "MCP surface", on ledger's MCP scaffolding. Second of ?4's four pull requests.

## Notes
- Each tool returns the document its CLI command prints under `--json` (ADR-0012); `issues_templates` returns `issues-templates/v1`, the shape a later `issues template list --json` will print.
- In a resource URI the `?` form of a number is written `%3F17`, because a literal `?` starts the URI's query; state headers refer to `issues://issue/<number>`.
- `issues_search` returns the document of 3a's `issues search`, so this issue depends on 3a.
- Don't start the issue before its scope's files are committed (?7).

## Done when
- `issues mcp` serves `issues_search`, `issues_get`, `issues_list`, `issues_ready`, `issues_for_path` and `issues_templates` over stdio, and the resources `issues://index`, `issues://ready` and `issues://issue/{id}`, where `{id}` is the id, the number or `%3F<number>`.
- Each tool's `structuredContent` is the document the CLI prints under `--json` for the same operation (`issues_templates`: `issues-templates/v1`), and invalid input, an unknown issue or an unreadable log is an `isError` result whose `structuredContent` is `ark-error/v1`.
- Every response that shows an issue's description leads with its state header: a duplicate's names its canonical issue and `issues://issue/<number>`, and a blocked issue's lists its open blockers.
- `issues_search` and `issues_list` read a `source` only from the local cache, as `verify` does.
- Unit tests, and an end-to-end test that drives the built `issues mcp` over stdio with the MCP SDK's client, cover the above; the issues README documents the read side; a changeset records the minor release.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
