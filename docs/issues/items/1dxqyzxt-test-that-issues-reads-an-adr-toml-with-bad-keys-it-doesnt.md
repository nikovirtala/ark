# Test that issues reads an adr.toml with bad keys it doesn't read

## Goal
Pin with a test that issues reads an `adr.toml` it shares a repository with without refusing it over keys issues doesn't read, so a later change can't swap `adrNumberingKeys` for a stricter parser unnoticed.

## Notes
Found in code review v1 of the pull request for ?39.

- `adrNumberingKeys` (`packages/issues/src/sources.ts:48`) validates only `[log]`, `main_branch` and `index` of adr's config; its comment says issues "never [refuses] an `adr.toml` over keys it doesn't read". ?39 put `parseSharedKeys`, which does refuse such keys, next to `parseNumberingKeys` in ledger, so the stricter call is now one identifier away.
- No test pins the property. `packages/issues/src/sources.test.ts:70` only checks that a bad `main_branch` or `index` is refused. In review, adding an `[scope] anchor_keyword` check to `adrNumberingKeys` left all 80 test files of issues passing (850 tests).

## Done when
- A test in `packages/issues/src/sources.test.ts` reads a decision log whose `adr.toml` has an invalid value for a key issues doesn't read (for example `[scope] anchor_keyword = "Adr"` or `[policy] auto_commit = "yes"`) and asserts that `readDecisionLog` returns the log with adr's numbers instead of throwing.
- The test fails when `adrNumberingKeys` calls `parseSharedKeys` instead of `parseNumberingKeys`.
