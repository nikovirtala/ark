# Pin applyPlan's after hint and stale note and the follow-renames blocked order in ledger's tests

## Goal
Make ledger's own tests fail when `applyPlan` drops the after-commit index hint or names the wrong tool in the "may be stale" note, or when `followRenamesChanges` checks the 200-glob limit before a view's `blocked` note, so a tool binding these helpers is protected by ledger and not only by adr's or issues' suites.

## Notes
Found in code review v1 of the change for ?42, which moved the write path's plan helpers and apply step into ledger.

- A mutation check of the new ledger tests (one mutation at a time, matching test file run) left three mutations alive with `apply-plan.test.ts` and `write-plan.test.ts` green:
  - `after: null` in place of `indexAfterHint(o.tool, o.plural, root)` (`packages/ledger/src/surfaces/apply-plan.ts:424`).
  - `run adr index` hard-coded in the "may be stale" note instead of `o.tool` (`packages/ledger/src/surfaces/apply-plan.ts:354`).
  - The `MAX_FOLLOWED_GLOBS` (200) check moved before the `blocked` check in `followRenamesChanges` (`packages/ledger/src/surfaces/write-plan.ts:264-273`).
- The first two are covered only at the tool level, by adr's `cli/write.test.ts:788` (`INDEX_AFTER`) and issues' `write.index.failures.test.ts:79` (the stale note). No test anywhere pins the third: a blocked view's note winning over the 200-glob `UsageError`.

## Done when
- A test in `packages/ledger/src/surfaces/apply-plan.test.ts` fails if `applyPlan`'s commit-failure hint drops `indexAfterHint(tool, plural, root)` when the index is in the commit.
- A test there fails if the "may be stale" note doesn't name `o.tool`.
- A test in `packages/ledger/src/surfaces/write-plan.test.ts` fails if `followRenamesChanges` checks the 200-glob limit before `blocked`: a blocked view with more than 200 followed globs gives its note and no `UsageError`.
