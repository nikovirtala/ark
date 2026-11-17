# Verify every commit builds; run tests at the branch tip

## Context
AGENTS.md asks for `git rebase --exec scripts/check-commit.sh origin/main` once, before a branch is marked ready for review (ADR-0010 keeps the log indexes fresh in every commit; `git bisect` needs every commit of `main` to build). The check ran the selected tests at each commit. [Pull request #111](https://github.com/nikovirtala/ark/pull/111) measured the cost (8 vCPU, Node 24, one run each): a check takes 0.6 s for docs only, 5.0 s for a log change and 171 to 281 s when it runs package tests; the fixed phases (install, lint, clean build, verify and index checks) add up to 5.6 s of a 280 s check, and the tests are 97 % of it. Over 78 work branches, the median has 5 commits (about 392 s per verification) and the p90 has 17 (about 1332 s). #111 recommended a tree-hash result cache. Under the once-before-ready rule a cache saves nothing (+1 %), and its payback is about 140 working days, so the maintainer rejected it. Tests of the tip already run in CI on every push.

## Decision
We will verify every commit of a branch without running tests, and run the tests on the branch tip.

- **Every commit** passes `scripts/check-commit.sh`: lint, install, a build from an empty `dist/`, `adr verify`, `issues verify` and the index checks. That keeps every commit of `main` buildable and its logs valid, so `git bisect` can check out any commit.
- **The tip** runs the tests: `pnpm test` locally before a branch is marked ready, and CI on every push, as today. `scripts/check-commit.sh --tests` keeps the old per-commit test selection for anyone who wants it.
- **A regression** is found by `git bisect run` on a copy of `scripts/bisect-tests.sh` (older commits don't have the script), which builds each step and runs the tests. A commit that can not be installed or built is skipped (exit 125), because its tests say nothing about the regression.

Options considered and rejected:
1. *A tree-hash result cache* around the per-commit check: no saving under the once-before-ready rule, 2 to 4 person-days to build, payback about 140 working days (#111).
2. *A merge queue*: it checks the tip against the new base, so a rebased branch gets no per-commit check.
3. *A CI job per commit*: cuts wall time at the p90 branch (1332 to about 501 s) but costs runner time on every push and leaves the local check as slow.
4. *Full lazy verification without the build check* (verify only when bisect needs it): saves the remaining 5.6 s per commit, but a commit that does not build cannot be bisected, and the log checks would fail late instead of at the commit that broke them.

## Scope
The per-commit check (`scripts/check-commit.sh`, `scripts/bisect-tests.sh`), the "Git history", "Commits" and "Before marking ready for review" rules in AGENTS.md, and the CI rule that tests run on the tip. It does not change what CI runs.

## Consequences
Easier: the check takes seconds per commit instead of minutes. The median branch (5 commits) drops from about 392 s to under 30 s, the p90 branch (17) from about 1332 s to under 100 s (modelled in #111; measured on the last 5 and 17 commits of `main` in the pull request that adopts this decision). Nothing new to maintain, no cache to invalidate.

Harder: a commit in the middle of a branch can fail its tests, and it can reach `main` through "Rebase and merge" as long as the tip passes. Only a `git bisect run` of the tests finds such a commit, and it needs the tests, minutes per step. A reviewer who checks out a mid-branch commit can meet a failing test.

Risk: a test failure in a middle commit is found only later, by a bisect that runs the tests, not when the commit is checked. The rule "each commit passes tests on its own" in AGENTS.md is replaced by "each commit builds and verifies on its own"; revisit this decision if bisects keep landing on mid-branch test failures.
