# Test init's index recovery hint and stale-index note in adr and issues

## Goal
Pin the two index recovery paths of a committing `init` in adr and issues with tests, so that ?43, which lifts both inits into ledger, cannot drop either one without a test failing.

## Notes
Found in code review v1 of the pull request for ?12, ?37 and ?38.

- The fix for ?38 adds two user-facing paths to `issues init` that mirror `adr init`: when git refuses the commit, the recovery hint now ends with `INDEX_AFTER(root)` (`packages/issues/src/init.ts:329`, `after: indexed ? INDEX_AFTER(root) : null`); when the post-commit refresh of the work tree's copy throws, init prints the note `<root>/index.md may be stale: …; run issues index` (`packages/issues/src/init.ts:346`).
- `adr init` has the same two paths (`packages/adr/src/init.ts:289` and `:306`). Neither tool tests them: `packages/issues/src/init.test.ts` and `cli/init.test.ts` have no such test, and `packages/adr/src/cli/init.test.ts:181` checks only the hint's `INIT_RERUN` part.
- ?43 (`nb1rxznb`) relies on "existing tests pass with no change to what they assert", so a lift that drops either path would still pass.

## Done when
- In each tool (adr and issues), a test has git refuse a committing `init` that writes `index.md` and asserts that the recovery hint ends with `INDEX_AFTER(root)`.
- In each tool, another test makes the post-commit refresh of `index.md` fail and asserts the `may be stale` note.
- Both tests pass on main.
