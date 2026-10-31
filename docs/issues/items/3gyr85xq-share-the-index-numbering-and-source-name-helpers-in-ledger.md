# Share the index-numbering and source-name helpers in ledger

## Goal
Move the helper that turns a source's committed index numbers into a `Numbering`, and the source-name pattern, into ledger, so adr and issues share one copy of each. Found by the semantic review of issues PR 2 (?3).

## Notes
- `indexNumbering` (a `Numbering` built from `readIndexNumbers`) is defined in `packages/adr/src/sources.ts:36` and `packages/issues/src/sources.ts:173`, and inlined a third time in `readSourceIssues` (`packages/issues/src/log.ts`, around line 257).
- The source-name pattern `/^[a-z][a-z0-9-]{0,31}$/` is defined in `packages/ledger/src/sources/config.ts:29` and again in `packages/ledger/src/cli/sources-command.ts:28`, `packages/adr/src/sources.ts:105` and `packages/issues/src/log.ts:212`, so a change to the name rule has to be repeated in four places.

## Done when
- ledger exports one helper that turns a source's committed index numbers into a `Numbering`, and one source-name pattern or validator.
- adr and issues use them, and no copy of either remains in adr, issues or ledger's `sources-command.ts`.
- ledger's `sources/qualified-id.ts` and `scope/anchors.ts` build their source-name part from the shared pattern, and so do the MCP `SOURCE` schemas of adr and issues and issues' `ISSUE_REF`, whose schema strings don't change.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
