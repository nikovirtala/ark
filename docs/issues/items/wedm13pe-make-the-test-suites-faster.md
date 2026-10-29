# Make the test suites faster

## Goal
Cut the time `pnpm test`, the CI test step and the per-commit check (`scripts/check-commit.sh`) take. The child issues each fix one cause.

## Notes
Measured on 2026-10-29 at e5fe532 (8 cores, Node 24.22, git 2.50):

- `pnpm test` took 6m38s: ledger 13s, adr 131s, issues 254s. `pnpm -r` runs them one after another. CI's "Test affected packages" step took 10.5 minutes on 4 cores.
- Summed per-file time is 63s for ledger, 666s for adr and 911s for issues, so adr and issues are bound by work, not by scheduling.
- The suites spawn about 214,000 git processes (ledger 5,587, adr 90,322, issues 118,199) and about 2,000 built-CLI processes.
- One library write in `issues/src/write.index.test.ts` spawns about 428 git processes. A third of them are repeated `rev-parse`s of HEAD and the main-ref candidates.
- A built CLI takes 130–155ms to start against 23ms for bare node. Most of the difference is ajv: `compileKind` compiles every event schema at load.
- `issues/src/write.index.test.ts` alone takes 255s in one worker. Split into 9 parallel slices it took 53s. Running its tests with `--sequence.concurrent` took 141–154s: workers are single-threaded and the library work between git calls is CPU-bound.

## Done when
- Every child issue is closed.
- `pnpm test` and the CI test step are timed again and the numbers are in the closing reason.
