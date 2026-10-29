# Keep every test file under its package's per-worker share

## Goal
Add a check that no test file takes longer than its package's summed file time divided by the worker count, and split the files that break it. Such a file is the last to finish no matter how vitest schedules the rest.

## Notes
- Both sides of the ratio scale with machine speed, so the rule holds on a laptop and in CI alike.
- On 8 cores (7 workers) at e5fe532: `packages/issues/src/write.index.test.ts` 255s against a 130s share, `packages/adr/src/cli/index-invariant.test.ts` 108s against 95s. No ledger file comes close.
- Split along the outermost loop of the test matrix (one file per precondition in both files) and give each property test its own file.
- `write.index.test.ts` split 9 ways with `-t` filters ran in 53s wall instead of 285s.
- The check can read the vitest JSON report, like `scripts/check-test-inputs.mjs` guards the test inputs.

## Done when
- A script reports every test file whose duration exceeds the rule, and the repository documents how to run it.
- No test file breaks the rule on an 8-core run.
- The PR closes this issue with before and after durations for adr and issues.
