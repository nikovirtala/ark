# Run each package's tests in its own CI job

## Goal
Run each affected package's tests in a separate CI job, so the test step takes as long as the slowest package rather than the sum of all of them.

## Notes
- On 4 cores CI's "Test affected packages" took 10.5 minutes at e5fe532: adr and issues need about 1,580s of file time between them, which is the step's length at 4 workers. Splitting files does not change that.
- Install, lint and build take about 4s, so repeating them per job is cheap.
- The job list has to keep the current selection: every package on a push to main or when workspace-level files change, otherwise the changed packages and their dependents, never the root `ark` package.

## Done when
- CI runs one test job per selected package, and a required status still fails when any of them fails.
- The selection matches today's for pushes to main, workspace-level changes and package-only changes.
- The PR closes this issue with the test step's wall time before and after.
