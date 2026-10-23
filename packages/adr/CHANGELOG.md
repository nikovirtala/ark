# @nikovirtala/adr

## 0.1.0

### Minor Changes

- b241ce5: First release (adr phase 1, "Core"): the decision kind on ledger (`@nikovirtala/adr/kind`), the library the CLI and the later MCP server share, and the `adr` CLI with `new`, `accept`, `supersede`, `list`, `show` and `verify`. Decisions are event logs in git: status is computed from the events, accepted bodies are frozen by their hash, numbers are assigned when an acceptance lands on main, and supersession chains lead to the decision in force. Writes stage by default and commit only with `--commit` or `auto_commit`, with exact `ADR`/`ADR-Event` trailers.

### Patch Changes

- Updated dependencies [b241ce5]
  - @nikovirtala/ledger@0.3.0
