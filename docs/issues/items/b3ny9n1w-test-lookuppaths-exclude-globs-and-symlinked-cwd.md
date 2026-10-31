# Test lookupPaths' exclude globs and symlinked cwd

## Goal
Cover the two `lookupPaths` options that ledger's own tests never reach, the `exclude` globs and a `cwd` given through a symlinked directory, so a change to either fails a test in ledger and not only, if at all, in a tool's suite.

## Notes
Found in code review v1 of the change for ?44.

- ?44 moved the `for`-path lookup of adr and issues into ledger as `lookupPaths` (`packages/ledger/src/scope/paths.ts`). It passes `exclude` on to the anchor scan (`packages/ledger/src/scope/paths.ts:120`) and resolves `cwd` with `realpath` before making paths repo-relative (`packages/ledger/src/scope/paths.ts:39`).
- `packages/ledger/src/scope/paths.test.ts` sets only `excludeDirs` (`:55`), never `exclude`, and its `cwd` test (`:99`) uses a real directory, so the `realpath` branch is not exercised.

## Done when
- A test in `packages/ledger/src/scope/paths.test.ts` passes `exclude` globs and asserts that anchors in matching files are not reported while anchors in other files still are.
- A test there calls `lookupPaths` with a `cwd` that is a symlink to a directory inside the repository and asserts that relative paths resolve to the right repo-relative paths.
- `paths.test.ts` stays under ledger's per-worker duration share (AGENTS.md "Test file durations").
