---
"@nikovirtala/ledger": minor
---

Sources are read from a local cache unless verify is asked to fetch them. `readSources(git, sources, { fetch: "cache" | "network" })` never touches the network in cache mode, where a source that isn't cached reads as `null`, and in network mode fetches each source and throws `SourceFetchError` (exit 2) when a fetch fails, even with an older pin cached. Statuses record the resolved `commit` and whether it was `fetched`; `verifyCommand` gains `--fetch-sources` and reports the statuses in the `sources` field of `ledger-findings/v1`, and `sourceFindings` gives one `sources/not-fetched` warning per referenced source that isn't cached. `sourcesCommand` is the shared `<tool> sources fetch [<name>]`, and `sourcesOfKinds` picks the entries of the kinds a tool reads. `DEFAULT_HOOK_COMMANDS["pre-push"]` passes `--fetch-sources`.

`verifyLog({ widenOn })` checks every subject in `staged` mode when the staged changes touch one of a tool's inputs outside the log (`touchedInputs`). A kind's `scope.requireMatchIn` (default `activeIn`) names the states whose scope globs must match tracked files. `renderCommitMessage` takes a `slot` (`before`, `after`, `quote`) and returns `note`, the shortened-title note naming the 72-character limit of the description; `joinActions` and `eventTrailers` build batch subjects and one trailer pair per subject and event type. The index-copy helpers (`holdsText`, `headBytes`, `headTree`, `writeIndexCopy`, `withoutPaths`, `firstLine`) move here from adr, and `ProjectContext.options` passes kind options to projections.

Changed behaviour: a `[[sources]] ref` that starts with `-` or `+`, or holds `:`, a glob or a revision suffix, is a `ConfigError`.
