# Test that issues' follow-renames dry run never adds the never-commits note

## Goal
Pin with an issues test that `followScopeRenames` with `dryRun: true` reports its plan without the "--follow-renames never commits" note and writes nothing, also when `[policy] auto_commit = true`.

## Notes
Found in code review v1 of the change for ?42.

- ?42 routes issues' follow-renames dry run through ledger's write driver: `write(log, "scope", plan, { ...o, commit: false, dryRun: true }, deps)` and an early `return` before the note is added (`packages/issues/src/write.ts:574-586`).
- Only a manual run checked it (a repo with `[policy] auto_commit = true`, one issue scoped to `src/a.ts` and `git mv src/a.ts src/b.ts` staged): the dry run gave `notes: []` with the issue in `affected`, before and after the change.
- No issues test calls `followScopeRenames` with `dryRun`. A later edit that merges the two `write` calls would add the note to the dry run with no test failing; the hooks (`hooks.ts:278`, `:293`) read only `dry.affected`, so they wouldn't notice.

## Done when
- An issues test runs `followScopeRenames` with `dryRun: true` on a log with `[policy] auto_commit = true` and a staged rename, and asserts `written: []`, `commit: null`, the changed issue in `affected`, no "--follow-renames never commits" note, and nothing staged.
