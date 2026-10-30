# Name the skipped CI test job without an unfilled expression

## Summary
When no package needs testing, the CI test job is skipped before its matrix expands, and GitHub lists it as `test (${{ matrix.package }})` with the expression shown literally.

## Steps to reproduce
1. Open a pull request that changes only `docs/issues/` (for example #43).
2. Look at its checks on GitHub.

## Expected
The skipped job has a readable name, or no job name holds an unexpanded expression.

## Actual
The checks list `test (${{ matrix.package }})` as skipped. `.github/workflows/ci.yml` names the job `test (${{ matrix.package }})` (line 121) and skips it with `if: needs.select.outputs.packages != '[]'` (line 124), so the matrix never expands. The required `check` job still passes; only the displayed name is wrong.

## Done when
- A pull request that tests no package shows no job name with an unexpanded expression.
- The required `check` status and the per-package test jobs work as before.
- The PR that does this closes the issue in the same change, with a reason saying how each condition was met.
