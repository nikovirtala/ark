# What verifying every commit of a branch costs

Status: draft. This part covers the stack, the workflow, a single verification run, where its time goes, how reproducible it is, the cost over the number of commits, how branches are made, how much of the suite a commit affects, spurious failures, what the pinned tools offer, and the options. The options are in the Options section; the recommendation is added in a later part and marked "to be added" below.

## How to read the numbers

Every number carries one of three labels.

- **measured**: read from a run on this host. The raw file is named next to the table, under `data/`.
- **derived**: computed from measured numbers by arithmetic shown in the text.
- **modelled**: an estimate from a stated assumption, not observed.

Times are seconds unless stated. **Wall** is elapsed time. **Machine time** is user plus system CPU seconds of the command and every process it started (bash `time`). With 8 cores, one wall second can hold up to 8 machine seconds. A range in brackets is min to max over the repeats, next to the median.

## Measurement environment

All **measured** unless noted. Raw: `data/host.txt`, `data/measured-commit.txt`.

| Item | Value |
|---|---|
| Host | 8 vCPU (Intel Xeon Platinum 8488C), 31 GB RAM, Linux 6.1, shared sandbox |
| Tool versions | Node 24.22.1, pnpm 12.15.0, git 2.50.1 |
| Commit measured | `232beda` on `main` (the base of branch `investigate/commit-verification-cost`) |
| Network | The npm registry answered over HTTPS, so installs from an empty store were measured, not skipped |
| Not like CI | CI runs the tests on a 4-core arm runner with 6 workers; this host has 8 x86 cores. Absolute times differ, ratios between phases are the transferable part |

Nothing in the repository was changed to take the measurements: no CI job, test, test configuration or dependency.

## Stack

All **measured** (read from the repository) unless noted.

- A pnpm workspace with three packages and a root: `ledger` (shared core, git-backed event-sourced records), `adr` and `issues` (tools built on ledger). Dependencies run `ledger` to `adr` to `issues`, and dependents import their dependencies' `dist/`.
- TypeScript 7.0.2 (`tsc -b`) and tsdown 0.23.1 bundles. Lint is biome 2.6.2 plus `scripts/check-test-inputs.mjs`.
- Tests: vitest 5.0.5 with `include: src/**/*.test.ts` in each package. Property tests use fast-check 4.10.2. 249 test files hold 3237 tests (adr 57 files and 689 tests, issues 81 and 872, ledger 111 and 1676).
- Test timeouts: adr sets no `testTimeout` (vitest default 5 s, but many describe blocks set their own, 60 to 120 s), issues 60 s, ledger 30 s.
- Many tests spawn the built CLIs (`node packages/<p>/dist/cli.js`) and git. `pnpm build` must run before the tests, and a test run needs a clean `dist/` to be trusted.
- Node 24 is required (`mise.toml`, `engines`).

## What "verified" means

All **measured** (read from `AGENTS.md`, `.github/workflows/ci.yml`, `scripts/check-commit.sh`) unless noted.

| Where | What is checked | Which commits |
|---|---|---|
| CI, every push and pull request | `select` picks packages; `verify` runs install, lint, build, agent-setup check, adr and issues `verify --base`, commitlint and fixup rejection; `test` runs one job per selected package with `--maxWorkers=6`; `docs-lint` runs markdownlint | The tip of the branch only. Commit messages are linted for every commit, but build and tests run on the tip alone |
| Locally, once before "ready for review" | `git rebase --exec scripts/check-commit.sh origin/main` | Every commit of the branch, after squashing fixups and rebasing |
| Pushing, working tree | Tests as the author likes. AGENTS.md says not to run the per-commit check after each fixup or push | Not applicable |

`scripts/check-commit.sh` limits the work by what a commit changes:

| Commit changes | Runs |
|---|---|
| Markdown outside `docs/adr`, `docs/issues`, `packages/*/src` that no test reads | lint |
| `docs/adr` or `docs/issues` only | lint, install, clean build, adr and issues verify and index checks, no tests |
| Files under `packages/<p>/` | the above and the tests of `<p>` and its dependents (`...{./packages/<p>}`) |
| A file in `scripts/test-inputs.txt` | the tests of the packages that read it, and their dependents |
| Anything else at workspace level, root commit or merge commit | the above and every package's tests |

Every non-docs commit removes `packages/*/dist` and rebuilds. The tests of the selected packages run one package after another (the packages depend on each other, so pnpm orders them), each with vitest's default worker count.

AGENTS.md documents the rule that makes the cost grow: the check costs "test suite duration times number of commits", and gives one data point from the authors, 33 commits in 29 minutes with selection instead of 63 without (documented by the repository, not re-measured here).

## The cost of one verification run

### Per commit kind

`scripts/check-commit.sh <base>` on a scratch worktree with one uncommitted edit of each kind (`scripts/check-commit-modes.sh`). 3 repeats. Raw: `data/check-commit.csv`. **Measured**.

| Commit kind | Wall median (range) | Machine time median (range) | Failed runs |
|---|---|---|---|
| docs only (Markdown) | 0.6 (0.6-0.6) | 2.9 (2.9-2.9) | 0 of 3 |
| decision-log change | 5.0 (5.0-5.0) | 13.4 (13.1-13.5) | 0 of 3 |
| change in `issues` only | 170.7 (170.6-171.5) | 1177.5 (1176.7-1181.1) | 0 of 3 |
| change in `adr` (adr and issues run) | 263.6 (263.0-264.0) | 1830.0 (1827.0-1835.9) | 0 of 3 |
| change in `ledger` (all three run) | 280.8 (280.2-282.0) | 1951.0 (1947.1-1959.3) | 0 of 3 |
| workspace-level file (all three run) | 280.3 (279.3-282.4) | 1947.5 (1941.0-1962.0) | 0 of 3 |

The cost is bimodal. A commit that no test reads costs under 6 s of wall time. A commit that triggers any package test costs between 171 s and 281 s, and the kinds differ by how many packages run: `ledger` and `adr` pull in their dependents.

### By phase

Each phase run alone, in the order of `check-commit.sh`, 3 repeats. Raw: `data/phases.csv`, `data/packages.csv`. **Measured**.

| Phase | Wall | Machine time | Grows with the number of tests? |
|---|---|---|---|
| install, node_modules present | 0.61 (0.60-2.25) | 0.98 (0.98-1.00) | No. Paid once per run |
| install, node_modules removed, store kept | 0.59 (0.58-0.60) | 0.98 (0.98-0.99) | No |
| install, empty store, from the registry | 1.57 (1.41-1.66) | 3.30 (3.30-3.36) | No |
| lint (biome and test-inputs check) | 0.55 (0.55-0.57) | 2.90 (2.87-2.92) | With repository size |
| typecheck, warm (`tsc -b`) | 0.38 (0.36-0.39) | 1.47 (1.47-1.52) | With code size |
| build, warm | 0.92 (0.89-0.93) | 1.34 (1.31-1.35) | With code size |
| build, clean (`dist/` and tsbuildinfo removed) | 2.01 (1.89-2.02) | 6.99 (6.73-7.15) | With code size. Used by `check-commit.sh` |
| adr verify | 0.55 (0.52-0.58) | 0.82 (0.77-0.85) | With the number of decision events |
| adr index check | 0.34 (0.33-0.36) | 0.46 (0.44-0.49) | With the number of decisions |
| issues verify | 0.86 (0.86-0.88) | 1.29 (1.25-1.31) | With the number of issue events |
| issues index check | 0.71 (0.70-0.73) | 0.91 (0.86-0.93) | With the number of issues |
| markdownlint (CI `docs-lint`, not part of `check-commit.sh`) | 1.27 (1.20-1.36) | 2.04 (1.87-2.17) | With the number of Markdown files |
| tests, adr, default workers (7) | 91.0 (90.3-94.0) | 633.0 (631.7-642.2) | Yes |
| tests, issues, default workers | 164.1 (163.2-170.9) | 1149.8 (1143.3-1156.4) | Yes |
| tests, ledger, default workers | 17.3 (17.1-18.5) | 119.4 (118.3-121.2) | Yes |

The fixed phases add up to 5.6 s of wall time (**derived**: install 0.6, lint 0.55, clean build 2.0, the four verify and index checks 2.5). The log-change kind in the table above, which runs the same phases, took 5.0 s (**measured**), so the sum is a fair estimate. Against the full check of 280 s that is 2%. The tests are the other 98% (**derived**: 272.3 s of tests, **measured** in the serial sum below, over 280.3 s).

The install phases are small here for two reasons: pnpm 12 is fast with a warm or empty store on this host's network, and the dependency set is small (252 packages, 209 MB store). A CI runner will see different install times and the numbers above do not transfer to it.

### Tests, package by package and by worker count

`vitest run --maxWorkers=<n>` with the JSON reporter. 3 repeats per worker count and 5 at the default (7 on this host, vitest's `availableParallelism() - 1`). Raw: `data/packages.csv`, `data/reports/`. **Measured** unless noted.

| Package | Workers | Wall | Machine time | CPU cores in use (machine time over wall, **derived**) |
|---|---|---|---|---|
| adr | 1 | 383.1 (381.8-385.1) | 476.4 (474.5-479.0) | 1.2 |
| adr | 2 | 196.7 (196.3-196.9) | 497.4 (496.0-498.2) | 2.5 |
| adr | 4 | 114.2 (113.7-114.6) | 562.3 (560.1-564.6) | 4.9 |
| adr | 6 | 95.0 (94.8-95.0) | 614.4 (613.6-614.9) | 6.5 |
| adr | 8 | 87.7 (87.3-87.7) | 639.4 (637.3-640.1) | 7.3 |
| adr | 16 | 92.5 (92.1-92.7) | 670.7 (670.4-672.4) | 7.2 |
| adr | default (7) | 91.0 (90.3-94.0) | 633.0 (631.7-642.2) | 7.0 |
| issues | 1 | 696.4 (695.9-698.2) | 852.9 (851.9-853.7) | 1.2 |
| issues | 2 | 356.9 (356.6-357.0) | 891.9 (891.4-892.1) | 2.5 |
| issues | 4 | 207.3 (207.0-207.6) | 1013.2 (1011.9-1014.9) | 4.9 |
| issues | 6 | 171.4 (171.0-171.7) | 1105.8 (1103.6-1107.3) | 6.5 |
| issues | 8 | 158.6 (157.9-158.7) | 1163.5 (1158.8-1163.8) | 7.3 |
| issues | 16 | 165.7 (165.5-167.0) | 1208.7 (1202.2-1221.2) | 7.3 |
| issues | default (7) | 164.1 (163.2-170.9) | 1149.8 (1143.3-1156.4) | 7.0 |
| ledger | 1 | 69.7 (69.5-69.7) | 88.2 (88.1-88.3) | 1.3 |
| ledger | 2 | 35.9 (35.7-36.2) | 91.3 (91.1-92.6) | 2.6 |
| ledger | 4 | 21.3 (21.3-21.4) | 105.7 (105.0-105.7) | 4.9 |
| ledger | 6 | 17.8 (17.8-18.2) | 115.2 (115.1-117.4) | 6.5 |
| ledger | 8 | 16.8 (16.8-16.8) | 121.0 (120.7-121.1) | 7.2 |
| ledger | 16 | 17.7 (17.6-17.8) | 127.6 (127.0-128.2) | 7.2 |
| ledger | default (7) | 17.3 (17.1-18.5) | 119.4 (118.3-121.2) | 6.9 |

The three packages together, as `pnpm -r run test` runs them (one after another; **derived** by summing the per-package runs of the same repeat):

| Workers | Serial wall | Slowest package alone (the CI matrix time) | Machine time |
|---|---|---|---|
| 1 | 1150.9 (1147.3-1151.0) | 696.4 (695.9-698.2) | 1418.5 (1414.4-1420.1) |
| 2 | 589.4 (589.4-589.5) | 356.9 (356.6-357.0) | 1480.7 (1480.5-1481.0) |
| 4 | 343.1 (342.0-343.3) | 207.3 (207.0-207.6) | 1682.8 (1677.0-1683.5) |
| 6 (CI's setting) | 284.2 (283.6-284.9) | 171.4 (171.0-171.7) | 1835.3 (1832.3-1839.6) |
| 8 | 262.8 (262.5-263.1) | 158.6 (157.9-158.7) | 1922.1 (1919.6-1924.0) |
| 16 | 275.9 (275.6-277.1) | 165.7 (165.5-167.0) | 2009.3 (1999.9-2019.3) |
| default (7) | 272.3 (271.7-283.4) | 164.1 (163.2-170.9) | 1904.9 (1902.8-1906.8) |

What this shows (**derived**):

- Seven workers cut the serial wall time from 1150.9 s to 272.3 s, a factor of 4.2, on 8 cores. The machine time rises from 1418.5 s to 1904.9 s (34% more) because the processes compete for cores, caches and the filesystem.
- Eight workers are the fastest setting here (262.8 s). Sixteen are slower (275.9 s) and cost the most machine time (2009.3 s). More workers than cores buy nothing and, as the flake section shows, break a test.
- A run of the whole suite uses 7.0 of 8 cores on average at the default setting. The suite cannot get faster by adding workers on this host. It gets faster only with more cores, less work, or by skipping work.
- On a CI-like 6 workers the slowest package (issues) takes 171.4 s. The CI wall time of the tests is that of the slowest package, and the check-commit time is the serial sum of the selected packages. For a commit that selects all packages, the two differ by a factor of 1.7 (**derived**: 284.2 over 171.4 at 6 workers).

### Worker balance

`node scripts/check-test-durations.mjs --workers 7` on the default-worker reports of run 1 (the repository's own rule: a file may take at most the package's summed file time divided by the workers). **Measured**, the script exits 0.

| Package | Files | Sum of file times | Share per worker (sum / 7) | Longest file |
|---|---|---|---|---|
| adr | 57 | 608 | 87 | 47 |
| issues | 81 | 1111 | 159 | 89 |
| ledger | 111 | 89 | 13 | 7 |

No file breaks the rule. The wall time of `issues` (164.1 s) is 1.03 times its share per worker (**derived**: 164.1 / 159), so the files are packed almost perfectly and further splitting of files would not shorten the run on this host. The file times at default workers are stretched by contention: the longest `issues` file takes 52 s alone at one worker and 89 s at seven (**measured**, `data/reports/issues-w1-r1.json` against `issues-wdefault-r1.json`).

## Where the test time goes

### By category

A static classification of every test file by what it imports, `scripts/categorize.mjs` (rule in its header). Raw: `data/file-categories.csv`, `data/category-times.csv`.

| Category | Meaning |
|---|---|
| unit | No fast-check, no child process in the import chain |
| git | Starts git (temp repositories via `@nikovirtala/ledger/testing`), no node child |
| cli | Starts a node child: the built `dist/cli.js` or an MCP server over stdio, and git |
| property, property+git, property+cli | Imports fast-check, with the above |

File counts and time at the default workers, sum over the files of a package, median (range) over 5 repeats. **Measured**.

| Package | Category | Files | Tests | Sum of file wall times |
|---|---|---|---|---|
| adr | cli | 39 | 414 | 555.1 (551.8-563.4) |
| adr | git | 6 | 154 | 1.4 (1.3-1.4) |
| adr | property+cli | 1 | 1 | 22.2 (20.2-23.8) |
| adr | property+git | 5 | 62 | 30.4 (29.5-30.7) |
| adr | unit | 6 | 58 | 0.2 (0.1-0.2) |
| issues | cli | 48 | 431 | 932.1 (926.6-938.0) |
| issues | git | 12 | 259 | 18.1 (17.9-18.6) |
| issues | property+cli | 1 | 1 | 40.5 (37.8-41.7) |
| issues | property+git | 9 | 106 | 109.9 (109.2-113.4) |
| issues | property | 1 | 14 | 0.2 (0.1-0.2) |
| issues | unit | 10 | 61 | 0.2 (0.2-0.2) |
| ledger | cli | 2 | 31 | 5.4 (5.0-5.6) |
| ledger | git | 37 | 533 | 39.1 (38.5-39.7) |
| ledger | property+git | 8 | 197 | 19.7 (18.3-19.9) |
| ledger | property | 29 | 472 | 26.5 (23.7-28.1) |
| ledger | unit | 35 | 443 | 3.3 (3.2-3.3) |

Shares of the 1802 s of summed file time (**derived**: sums of the medians above, 607.7 + 1099.8 + 94.2):

| Category | Seconds | Share |
|---|---|---|
| cli (tests that start the built CLIs or MCP servers) | 1492.6 | 83% |
| any property test (fast-check), with git or cli | 249.4 | 14% |
| git only | 58.6 | 3% |
| unit | 3.9 | 0.2% |

The tests are not slow because of computation. Almost all of the time is in tests that start a process: a git repository is created for each test, the built CLI is started with `node`, and each CLI call starts git several times. Plain unit tests (no process, no property) make 0.2% of the time. The counts are from a static import analysis: a test that imports only the `@nikovirtala/ledger` library but starts git inside the library counts as unit or property. So the git-backed time of `ledger` is understated and its "unit" and "property" figures include some git work.

The index-invariant files run their cases with `describe.concurrent` (`adr/src/test-support/index-invariant.ts`, **measured**: read from the source), so the durations of a file's tests can add up to more than the file's wall time: for the `cli` files of adr they sum to 908.3 s against 555.1 s of file wall time (**measured**, median of 5 repeats, `data/category-times.csv`).

### Slowest files and tests

Default workers, median (range) of 5 repeats. **Measured**. The full list is in `data/summary.txt`.

| File | Category | Tests | File wall time |
|---|---|---|---|
| issues/src/mcp-e2e.write.test.ts | cli | 8 | 86.4 (85.9-89.2) |
| issues/src/mcp/write-tools.test.ts | cli | 9 | 84.4 (83.6-87.0) |
| issues/src/mcp-e2e.table-b.test.ts | cli | 5 | 59.6 (56.6-59.6) |
| issues/src/mcp/write-tools.table-b.test.ts | cli | 5 | 57.6 (55.5-57.9) |
| issues/src/mcp/read-tools.test.ts | cli | 10 | 49.5 (49.4-50.9) |
| issues/src/e2e-guardrails.test.ts | cli | 6 | 48.7 (48.1-50.6) |
| adr/src/cli/write.test.ts | cli | 39 | 46.7 (46.4-47.3) |
| adr/src/cli/hooks.test.ts | cli | 19 | 43.9 (43.4-44.0) |
| issues/src/hooks.test.ts | cli | 13 | 41.0 (40.3-41.8) |
| issues/src/cli/commit-staged.test.ts | cli | 22 | 40.8 (40.3-41.3) |

The slowest single tests are property tests over the CLI: `issues/src/write.index.property.test.ts` ("index property keeps the invariant over random write sequences", median 40.5 s), `adr/src/cli/index-invariant.property.test.ts` (22.2 s), then end-to-end demo and Table B tests at 14 to 21 s (**measured**). Each runs a sequence of CLI invocations, and each invocation costs a node start plus the git processes the CLI starts. The likely reason these tests take as long as they do is the number of processes they start, not the amount of data (**derived**: the unit and in-process property tests, which start none, take 0.2% of the time; the per-process cost itself was not isolated).

## Reproducibility and flakes

Every package suite was run 23 times at between 1 and 16 workers, and the whole suite 5 times at the default setting. Raw: `data/packages.csv` (exit codes), `data/reports/` (every test result), `data/summary.txt` (the list of failures). **Measured**.

| Setting | Runs per package | Failed runs | Where |
|---|---|---|---|
| Default workers (7), the whole suite | 5 | 0 of 15 package runs | none |
| 2, 4, 6 and 8 workers | 12 | 0 of 36 | none |
| 1 worker | 3 | 1 of 9 | issues, 1 test |
| 16 workers, twice the cores | 3 | 2 of 9 | adr, 1 test, both times the same one |

No test failed at the default setting, at the 6 workers that CI uses, or at 4 or 8. The three failures have two causes.

### A test whose search term matches a random id (issues, 1 worker, 1 of 3 runs)

`packages/issues/src/mcp/read-tools.test.ts`, "issues_search returns searchIssues' document, headers in its text", line 108. The test searches for `zzz` and expects "No open issues match." with nothing else. The answer was "No open issues match.\n1 closed issue…" (`data/reports/issues-w1-r2.json`).

Cause (**derived** from the sources, not reproduced because the temporary repository is deleted after the test): issue search matches a query against ids, and `newSubjectId` makes ids of 8 random Crockford base32 characters (`packages/ledger/src/identity/ids.ts`). The fixture's titles, comments and reasons contain no `zzz`, so a closed issue matched only if its random id contains `zzz`. A simulation of 20 million ids found that 0.0177% of ids contain `zzz` (**measured**, `scripts/id-zzz-estimate.mjs`, `data/id-zzz-estimate.json`). The fixture has two closed issues, so the test fails with a probability of about 0.035% per run (**modelled**: 2 times 0.0177%, treating the ids as independent). One failure in the 23 runs of this test is an unlikely draw under that rate (about 0.8%, **modelled**), so the cause is likely but not proven. The failure does not depend on the load: the id is random whatever the worker count. That is about one failure in 2800 runs of the issues package (**modelled**: 1 / 0.00035), which a per-commit check of a long branch meets sooner than a single CI run does.

Because fast-check's default seed is random and not stored, a property test failure of the same kind would also be non-reproducible without the printed seed (next section).

### A test too close to its default timeout (adr, 16 workers, 2 of 3 runs)

`packages/adr/src/cli/scope.test.ts`, "lets a proposed decision name code that doesn't exist, and checks it once accepted", line 401, failed with "Test timed out in 5000ms". Its `describe` sets no timeout, unlike the neighbouring blocks in the same file that set 90 and 120 s, so it gets vitest's default of 5 s (`packages/adr/vitest.config.ts` has none). The duration of this one test grows with the number of workers (**measured**, `data/reports/adr-w*-r*.json`):

| Workers | Runs | Test duration, ms, median (range) |
|---|---|---|
| 1 | 3 | 1333 (1331-1353) |
| 2 | 3 | 1386 (1382-1453) |
| 4 | 3 | 1618 (1600-1667) |
| 6 | 3 | 1965 (1941-2007) |
| default (7) | 5 | 2255 (2225-2280) |
| 8 | 3 | 2457 (2443-2509) |
| 16 | 3 | 5236 (4582-5242) |

At the default workers the test uses 45% of its timeout (**derived**: 2255 / 5000). On a 4-core CI runner with 6 workers the load per core is 1.5, between this host's 1.0 (8 workers) and 2.0 (16 workers). Reading the table, the test would take roughly 3.5 to 4 s there (**modelled**: linear interpolation between 2457 ms and about 4600 ms, not measured). A slower runner or a few more workers moves it past 5 s. This is a risk for a per-commit check on a loaded machine, and a cost: a flaky failure at commit k of N costs a rerun of the rebase from commit k.

### Property tests: seeds, runs, persistence

All **measured** (greps over `packages/*/src`).

- 63 of 249 test files import fast-check.
- `fc.configureGlobal` is used nowhere, so the defaults hold: 100 runs per property unless `numRuns` is given, and a random seed per run. A failing run prints the seed and the counterexample path in the vitest output, and nothing stores them.
- `numRuns` is set on 44 lines, from 10 (CLI-backed properties, each run starting processes) to 300 (pure properties). Many properties set `endOnFailure: true`, which stops shrinking at the first counterexample.
- Nine places fix a seed: six `fc.sample` calls that generate example data (adr `kind/properties.test.ts` and `verify.test.ts`, issues `merge.test.ts`, ledger `testing/history.test.ts` twice and `verify/fold-properties.test.ts`), the `RUNS` constant of `issues/src/test-support/generators.test.ts`, and two `fc.check` calls in ledger `testing/history.test.ts`. The other `fc.assert` properties run with random seeds.
- No `examples:` option and no stored counterexample file. A failure found on one commit is not replayed on the next.
- A per-commit check therefore runs different random inputs on every commit. This is useful for finding bugs and means two verifications of the same tree can differ. In the 69 runs measured, no property test failed (**measured**).

### What the tests depend on outside the repository

**Measured** (read from `ledger/src/testing/temp-repo.ts` and a search of the tests).

- The `git` binary on the PATH (2.50.1 here), for every git-backed test. No test pins a git version.
- Hermetic git: each temp repository gets an empty global config, `GIT_CONFIG_NOSYSTEM=1`, a private `HOME` and a fixed identity, and the `GIT_*` locating variables are unset. A developer's git config does not leak in.
- The temp directory (`os.tmpdir()`), one `mkdtemp` per test repository, removed in `afterEach`. On a small or slow `/tmp` this is shared state between workers only through the filesystem.
- The built `dist/` of the package and of its dependencies. A stale `dist/` is a source of false results, which is why `check-commit.sh` removes it for every non-docs commit.
- No network: the source-fetching tests use a second temporary repository as the remote (`ledger/src/sources/fetch.test.ts`). The only `github.com` strings in the tests are in text fixtures and parsed configuration.
- The clock: 36 test lines use `Date.now` or `new Date`, no test uses fake timers, and the code stamps events with the real time. Tests that need order use a `clock` option of the temp repository. A run is not bound to the date, and two commits in one millisecond are handled by the ULID factory.
- The number of cores and the load of the machine, through test timeouts as shown above.

## Cost over the number of commits

Raw data: `data/ops-cells.csv` (one row per cell), `data/ops/<cell>.jsonl` (one row per checked commit), `<cell>.pre.json` and `<cell>.post.json` (the commits before and after the operation). A cell is a branch of N real commits, one operation on it, and then the verification of `AGENTS.md`: `git rebase --exec scripts/check-commit.sh <base>`. The derived tables are written by `node scripts/fit-cost.mjs` into `data/fit.csv`, `kind-costs.csv`, `cost-along-branch.csv`, `model-vs-measured.csv`, `first-failure.csv` and `rewrite-counts.csv`. Runs were serial, one at a time, on the host described above.

### The windows

- **old** (`data/window.txt`): 20 consecutive commits of main that are mostly logs. Of the first 20: 12 log, 3 docs, 4 issues-package and 1 adr, issues and ledger commit (**measured** from `kind-costs.csv`). The first N=1 and N=2 cells (and cells for 5 commits) come from this window. At N=1 and N=2 every commit is a log commit that runs 0 tests. Those cells are kept and labelled **log-only mix, 0 tests, not representative**: 4.2 s per commit measures `lint`, `install`, a build and the log `verify`, nothing else.
- **pk** (`data/ops-window.txt`): five consecutive issues-package commits, each of which runs the package tests (732 to 754 tests, 59 to 61 files). The N=1 and N=2 cells that the cost curve uses come from here. Cells carry the prefix `pk-`.
- **pr** (`data/ops-window-pair.txt`): a test-only issues commit and a docs-only commit, an independent pair for the reorder cells. Prefix `pr-`.

### Cost against N

All verification wall times in seconds. **Measured** unless marked. Ranges are min to max over the repeats.

| Cells | N | Repeats | Verification wall time | Tests run |
| --- | --- | --- | --- | --- |
| old, log-only mix, `first` | 1 | 3 | 4.2 (4.1 to 4.2) | 0 |
| old, log-only mix, `first` | 2 | 3 | 8.3 (8.2 to 8.4) | 0 |
| pk, package commits, `first` | 1 | 3 | 307.2 (302.4 to 311.8) | 732 |
| pk, package commits, `first` | 2 | 2 | 622.3 (619.5 to 625.0) | 1470 |
| old, mixed, `first` | 5 | 3 | 174.6 (174.0 to 175.4) | 768 |
| old, mixed, `first` | 10 | 1 | 462.3 | 1536 |
| old, mixed, `first` | 20 | 1 | 987.4 | 3918 |

The N=10 and N=20 cells are single repeats. The repeat spread at N=5 is under 1 %, so one repeat is a fair sample, but it is one sample. Raw rows: `ops-cells.csv`.

Every operation costs the same as `first` at the same N, because `git rebase --exec` replays and checks all N commits whatever the operation changed. At N=5 the seven operations ran 173.6 to 179.8 s over 3 repeats, at N=10 `first`, `rebase`, `fixup-first`, `reorder` and `reword-mid` ran 462.3 to 467.6 s (**measured**). N=20 for any operation other than `first` is **modelled** at 987 s (about 1 %, the spread seen at N=5 and N=10), with no measured cell.

### Fit: a fixed part and a part per commit

`data/fit.csv` holds the least-squares fit of verification wall time against N for each operation. On package-testing commits (pk) the line is a straight line through the origin:

| Operation (pk) | Fixed part (s) | Per commit (s) | Points |
| --- | --- | --- | --- |
| `first` | -7.8 | 315.0 | 5 cells, N=1 and 2 |
| `rebase` | -18.2 | 320.1 | 2 cells |
| `fixup-first` | 0.9 | 303.8 | 2 cells |
| `reword-mid` | -8.8 | 313.3 | 2 cells |
| `fixup-last` | n/a | 307.8 | 1 cell (N=2 only) |

Labelled **measured fit** on two values of N, so the intercepts (all within 20 s of zero) are not meaningful. The check has no fixed cost of its own, the operation takes 0.05 to 0.3 s (`op_wall_s`), and one commit costs about 305 to 320 s. A fit on two values of N does not test linearity.

On a mixed branch (old window) a straight line of cost against N does not describe the data. The fit for `first` over N=1, 2, 5, 10 and 20 has intercept -77 s and 52.9 s per commit with r2 0.995, and the other operations give 51 to 58 s per commit. The negative intercept shows that the line is wrong in kind: the cost is a sum over commits of different kinds. The kind-weighted fit on the per-commit rows of the N=20 cell, over its 20 running totals, is (**derived** from measured rows, r2 0.994):

total(N) = 12.9 + 6.6 x N + 173.2 x (package commits among the first N) seconds

The non-test commits cost about 6.6 s each (`lint`, `install`, a clean build and the log `verify`), a package-testing commit adds about 173 s. The mean per commit kind measured in this window (`kind-costs.csv`):

| Kind | Commits | Mean wall (s) | Source |
| --- | --- | --- | --- |
| docs | 3 | 0.5 | measured |
| log | 41 observations | 4.2 | measured |
| issues package (old window, after the test split) | 8 | 162.6 (157.3 to 167.9) | measured |
| issues package (pk, before the split) | 7 | 309.4 (302.3 to 314.4) | measured |
| adr, issues and ledger | 2 | 267.4 | measured |

### Why N=5 averages 35 s per commit

The N=5 cell holds four log commits (4.2 s each) and one issues commit (158.6 s). The mean is (4 * 4.2 + 158.6) / 5 = 35.1 s (**derived**), against 171 to 281 s for any one commit that triggers package tests. Per-commit cost is bimodal, and the average per commit of a branch is the share of test-triggering commits times about 170 to 310 s plus a few seconds. The share in this window is 5 of 20 (25 %), and it is 30.5 % in the 400 commits of `data/commit-modes.csv` (**measured**; 122 of 400 commits run package or full tests, corrected from 130 and 33 % in an earlier draft).

The pk commits cost 307 s each while the same kind, an issues-only commit, cost 160 s in the old window and 171 s in the single-kind measurement at the tip. The pk commits predate the commit that split the issues MCP tests (the commit before that window's `c5`). They run 732 tests in 59 files against 768 in 73 files after, with a similar CPU time (819 s against 899 s user time) and nearly twice the wall time. That is consistent with one long test file that sets the wall time (see "Test file durations" in `AGENTS.md`). I did not run the file split to confirm it, so the cause is **inferred**. For the cost of verifying a commit it means that the cost of one commit depends on the test suite as that commit has it, not on the suite at the tip.

The kind-weighted model that uses the per-kind costs of `check-commit.csv` (docs 0.6, log 5.0, issues 171, adr 264, ledger and full 281 s) over-predicts the old window by 4 to 22 % (`model-vs-measured.csv`, **modelled** against **measured**): 20 % at N=1 and 2 (5.0 against 4.2 s per log commit), 9 % at N=5, 6 % at N=10 and 4 % at N=20. For the pk window it under-predicts by 44 to 46 % for the reason above.

### Cost along the branch

`data/cost-along-branch.csv` has the per-commit wall time and the running total (**measured**). In the N=20 run the running total is 175 s after 5 commits, 462 s after 10 and 987 s after 20. The heavy commits (`c5`, `c7` and `c12` to `c14`) are where the curve steps, and the log and docs commits between them add 0.5 to 4.4 s. For the pk window every commit adds 303 to 314 s, a straight line.

### Sequential against separate runs

The second commit of the pk branch cost 310.5 s and 310.6 s inside the two N=2 runs, and 311.3 s checked alone (cell `pk-n02-alone-2-r1`, **measured**). The third commit alone cost 311.6 s. A run in sequence gets no cache benefit from the commits before it: `check-commit.sh` removes `dist/` and rebuilds each time. The N commits therefore cost the same in one `rebase --exec` as in N separate runs on one machine, and the total machine time (user plus system, about 1 050 s per package commit **measured**) is the same.

Separate runs would allow parallelism. A single package commit uses about 3.4 cores on the 8-core host (machine time 1 050 s over 311 s wall), so two separate runs fit the host and a third would not. That is **modelled** from the core count, not measured, because parallel runs distort each other's timing. With one machine per commit the wall time would be that of the slowest commit (about 310 s) rather than the sum.

### Time to the first failure

A commit with a deliberate defect is added to a three-commit pk branch (as a fixup, applied with autosquash) at the first, middle or last position (`data/first-failure.csv`, scratch clone only). A failing check stops `git rebase --exec`, so commits after the failure are not checked. Verification wall time until the stop, **measured**; the clean 3-commit run is **derived** as 3 times the mean pk commit (937 s).

| Defect | Position | Commits checked | Wall time (s) | Share of a clean run |
| --- | --- | --- | --- | --- |
| does not compile | first | 1 | 1.8 | 0.2 % |
| does not compile | middle | 2 | 316.7 | 34 % |
| does not compile | last | 3 | 631.8 | 67 % |
| a failing test | first | 1 | 304.8 | 33 % |
| a failing test | middle | 2 | 612.0 | 65 % |
| a failing test | last | 3 | 924.6 | 99 % |

A compile error stops the check after `lint` and the start of the build, a few seconds into the broken commit. A failing test stops it only after the test phase of that commit, about 305 s. After the fix, `git rebase --continue` resumes from the fixed commit, so the commits before it are not checked again. The cost of one broken commit at position k is then about k commits of checking before the failure plus the rest after the fix (**derived**).

A first attempt of the failing-test cells wrote a test file that `biome` rejects, so those cells failed at `lint` after 0.5 s. They were discarded and rerun with a formatted file. The rows in the CSV are from the rerun.

### Rewritten against tree-changed commits

`data/rewrite-counts.csv` has, for every cell, the commits rewritten (new sha), those with a changed tree, patch or message, and the time a check that skipped commits whose tree and parent tree are unchanged would save. The counts are **measured**. The saving is **derived** and no such check exists in `scripts/check-commit.sh`.

| Operation | N | Checked | Rewritten | Tree changed | Skippable share of the time (derived) |
| --- | --- | --- | --- | --- | --- |
| `first` (no change) | 5 | 5 | 0 | 0 | 100 % (already verified) |
| `rebase` onto newer main | 5 | 5 | 5 | 5 | 0 % |
| `fixup-first` | 5 | 5 | 5 | 5 | 0 % |
| `fixup-mid` | 5 | 5 | 3 | 3 | 5 % |
| `fixup-last` | 5 | 5 | 1 | 1 | 9 % (the changed commit is the heavy one) |
| `reword-mid` | 5 | 5 | 3 | 0 | 100 % |
| `reorder` (swap 2 and 3) | 5 | 5 | 4 | 1 | 95 % |
| `reorder-at4` | 5 | 5 | 2 | 1 | 7 % |
| `fixup-first` | 10 | 10 | 10 | 10 | 0 % |
| `reorder` (swap 5 and 6) | 10 | 10 | 6 | 1 | 64 % |
| `reword-mid` | 10 | 10 | 6 | 0 | 100 % |
| `reword-mid` (pk) | 2 | 2 | 2 | 0 | 100 % |

A reword rewrites every commit after it and changes no tree, yet the check runs on all of them and costs the full 462 s at N=10. Table values are single cells or the same in all 3 repeats.

### Why a reorder run fails

Raw excerpts: `data/reorder-failures.txt`. A reorder of two commits exits 1 and checks one commit in two different cells, for two different reasons, and that is a result about "every commit passes":

1. **Old window, N=2** (two log commits): each log commit regenerates `docs/issues/index.md`. After the swap, the first replayed commit carries an index generated for a state that does not exist, and `issues verify` reports `index/stale`. The commit passes in the original order and fails in the swapped order, with no conflict from `git`.
2. **pk window, N=2**: the second commit uses `refuseIncomplete`, which the first commit adds. After the swap, the build of the commit that now comes first fails with `TS2353` (the option does not exist yet). Wall time 1.8 s, 0 tests.

An independent pair (`pr` window, a test-only commit and a docs-only commit) reorders and passes: 2 checked, exit 0, 324.4 s and 323.6 s over 2 repeats (**measured**). Reordering commits that touch the same generated file or the same code changes what each commit builds, so every commit of a reordered branch has to be checked again, and a reorder of dependent commits fails the first check that it reaches. The cost of a failing reorder is low (a few seconds to the failing commit), but a stop there tells nothing about the later commits.

### Discarded and kept data

- `n10-first-r1` and `n10-rebase-r1` (left uncommitted by an interrupted run): 10 of 10 commits checked, exit 0, JSON rows complete, and consistent with the other N=10 cells. Kept.
- `n10-fixup-first-r1` from the interrupted run: 6 of 10 rows and no row in `ops-cells.csv`. Discarded and measured again.
- The first attempt of the `break-test-*` cells: see above. Discarded.

## How branches are made

Source: the GitHub REST API (`scripts/collect-prs.sh`, `scripts/analyze-prs.mjs`), raw rows in `data/prs/` (`pulls.jsonl`, `pull-details.jsonl`, `runs.jsonl`, `jobs.jsonl`, `jobs-prior.jsonl`), one row per pull request in `data/pr-branches.csv`, statistics in `data/pr-summary.json`. Only counts, numbers, shas, branch-name prefixes and timestamps are stored. All numbers in this section are **measured** unless labelled.

**Source reliability.**

- The repository is small and young: 108 closed pull requests collected (105 merged, 3 closed without merging) between 2026-10-22 and 2026-11-14, against 666 commits on `main`. Percentiles over 78 branches are coarse; p90 is the 8th largest value.
- Merges use "Rebase and merge", so the merge shas differ from the head shas, and `main` stays linear (no merge commits, 0 of 666). The number of commits of a pull request comes from `pulls/{n}`, the commit list from `pulls/{n}/commits`.
- Not every commit of `main` came through a pull request, and not every pull request commit is on `main` as it was: the merged pull requests carry 674 commits in total (summed `commits`), the first-parent log of `origin/main` at collection time has 666 commits in total, and commits dropped or merged by a rebase or a force push explain the difference. The commit counts below are for pull request branches at merge time, so they describe branches, not all of `main`.
- Pull requests that the release bot opens (`changeset-release/*` and `release*` branches, 27 of the 105 merged) are shown apart ("release"). The remaining 78 are "work" branches written by people and agents. This split is by branch-name prefix and is a guess at who wrote the branch.
- A force push is the `head_ref_force_pushed` event of `issues/{n}/events`. The event also fires for a plain `--force-with-lease` after an amend, so it counts rewrites, not rebases onto `main` only.
- "Main movement" is not readable from `base.sha`: the API reports the base at merge time, so `main_since_base` is 0 for all 105 (in `pr-branches.csv`, kept for the record and not used). The substitute counts commits on `main` whose committer time falls between opening and merging, minus the branch's own commits (`main_while_open`). Rebase merges rewrite committer times and direct pushes count too, so treat it as an estimate of main movement (**derived**, low reliability).

### Commits per branch

| Group | Branches | Mean | Median | p75 | p90 | Max |
|---|---|---|---|---|---|---|
| Work, merged | 78 | 8.3 | 5 | 9 | 17 | 60 |
| Release, merged | 27 | 1.0 | 1 | 1 | 1 | 2 |
| All merged | 105 | 6.4 | 3 | 8 | 14.6 | 60 |

Histogram of work branches by commits (**measured**): 1: 15, 2: 8, 3 to 5: 19, 6 to 10: 18, 11 to 20: 12, over 20: 6. 23 % of the work branches have more than 10 commits (18 of 78). The work-branch lifetime from opening to merge has median 1.7 h and p90 8.6 h.

### Force pushes and main movement

| Group | Share with at least one force push | Mean force pushes | Median | p90 | Max |
|---|---|---|---|---|---|
| Work, merged (78) | 67 % | 1.14 | 1 | 3 | 5 |
| All merged (105) | 56 % | 1.06 | 1 | 3 | 12 |

By branch size (work branches, **measured**): 1 to 2 commits: 61 % force-pushed (23 branches), 3 to 5: 53 % (19), 6 to 10: 67 % (18), over 10: 89 % (18), with a mean of 1.8 force pushes for the largest. Longer branches get rewritten more often. Per `AGENTS.md`, each rewrite of a branch that is later rebased invalidates a per-commit verification, because the check covers the commits as they were.

On 46 % of the work branches at least one commit landed on `main` while the branch was open (**derived**, see reliability), median 0 and p90 14.6 commits. The tip-only check in CI has no such exposure (it tests the pull request merge), but a per-commit check is only valid for the base it ran on, and a rebase onto the moved `main` replays all N commits.

### Expected cost per branch

**Modelled**: N times the mean per-commit cost of the commits of `main`. The mean is 78.4 s per commit over the last 400 `main` commits (**derived**: each commit classified with the `check-commit.sh` rules and priced with the per-mode times of `data/check-commit.csv`, see the next section; `data/affected-share-400.csv`). The second column uses the kind-weighted fit of the cost section (12.9 + 6.6 N + 173.2 per package commit, with 30.5 % of commits running tests; the 173 s was measured on a window that is mostly issues-only commits, so the fit gives lower numbers). The third column is the worst case in which every commit runs every package (280.8 s each). Times are one verification run on this host.

| Branch size | N | Mixed, 78.4 s each | Fit | Every commit runs all tests |
|---|---|---|---|---|
| Work, median | 5 | 392 s (6.5 min) | 310 s | 1404 s (23 min) |
| Work, p90 | 17 | 1333 s (22 min) | 1023 s | 4774 s (80 min) |
| All merged, median | 3 | 235 s | 191 s | 842 s |
| All merged, p90 | 15 | 1176 s | 904 s | 4212 s |

A branch that is rewritten and verified again after each rewrite pays this once per verification. With 1.14 force pushes per work branch on average (**measured**), the cost per branch lies between one verification (only before marking ready, as `AGENTS.md` asks) and about 2.1 times that (**modelled**: 1 + 1.14, if every rewrite is verified again). The CI test job on the 4-core arm runner takes a median of 295 s for issues, 169 s for adr and 44 s for ledger on success (**measured**, `data/pr-summary.json`, `test_jobs_by_package`), against 164, 91 and 17 s here. CI tests only the tip, so a branch with N commits costs CI one run and the per-commit check about N times the mixed mean.

### CI runs and rerun rate

**Measured**, 685 `CI` workflow runs (`data/prs/runs.jsonl`, 581 on pull requests and 104 pushes to `main`):

| Result | Runs |
|---|---|
| success | 378 |
| failure | 76 |
| cancelled | 218 |
| action required (first-time approval) | 13 |
| Run again at least once (`run_attempt` 2) | 39 (36 passed, 3 did not) |

Cancelled runs are expected: the workflow cancels a pull request run when a newer push arrives (`concurrency` with `cancel-in-progress`, `.github/workflows/ci.yml` lines 11 to 13). Of the 454 runs that finished with success or failure, 76 failed (16.7 %). No failed run had a later successful run on the same head sha without a rerun (0 of 76), so failures were fixed by new commits or by a rerun. Of the 685 runs, 39 are reruns. The jobs API only returns the latest attempt of a rerun, and the first attempt's jobs were readable for 4 of the 39 reruns (the others return no jobs): in those 4, the failed first-attempt jobs were `test` (2) and `check` (2). So the cause of the 36 passed reruns is unknown: a spurious failure, an infrastructure failure, or a deliberate rerun. The test matrix jobs failed in 21 of 590 completed jobs (3.6 %): issues 5 of 199, ledger 9 of 193, adr 7 of 198. Those include real failures.

## Share of the suite a commit affects

`scripts/affected-share.mjs` applies the `check-commit.sh` rules to each commit: the changed files of `<sha>~1..<sha>`, the `scripts/test-inputs.txt` of that commit, the workspace graph (ledger, then adr, then issues, so a ledger change tests all three and an adr change tests adr and issues). Each commit gets a test share (the summed default-worker test wall time of the packages it runs, over the sum of all three: 91.0 + 164.1 + 17.3 = 272.4 s, **measured**) and a check wall time from `data/check-commit.csv`. Raw: `data/affected-share.csv` (100 commits ending at `232beda`), `data/affected-share-400.csv` (400 commits). The 400-commit classification gives the same mode for all 400 commits as `data/commit-modes.csv` (**measured**, 0 differences).

| What the commit changes | Last 100 commits | Last 400 commits | Share of the suite's test time | Check wall time each | Share of all check time (400) |
|---|---|---|---|---|---|
| Docs only | 7 | 45 (11.3 %) | 0 % | 0.6 s | 0.1 % |
| Decision or issue log only | 87 | 233 (58.3 %) | 0 % | 5.0 s | 3.7 % |
| Issues package only | 0 | 33 (8.3 %) | 60.3 % | 170.7 s | 18.0 % |
| Adr package (adr and issues run) | 0 | 26 (6.5 %) | 93.6 % | 263.6 s | 21.8 % |
| Ledger, or several packages (all run) | 2 | 47 (11.7 %) | 100 % | 280.8 s | 42.1 % |
| Workspace-level file (all run) | 4 | 16 (4.0 %) | 100 % | 280.8 s | 14.3 % |

(The last 100 commits contain no issues-only or adr-only commit: 87 log, 7 docs, 2 package commits that run all three packages and 4 workspace-level commits.) The Markdown, log and docs commits cost 5 s or less. In the 400 commits, 30.5 % run tests (**measured**; 122 of 400 have mode `pkg` or `full` in `data/commit-modes.csv`, a correction of the 130 of 400, 33 %, in an earlier draft of the section on why N=5 averages 35 s), they take 96 % of the check time. The mean test share per commit is 6.0 % in the last 100 commits and 26.8 % in the last 400 (**derived**). The last 100 commits are a stretch of log work, so they understate the cost of a branch of code commits. The kind of branch decides the cost: a branch of N log commits costs 5 N seconds, a branch of N package commits costs about 171 to 281 N.

What these shares say about avoiding work (**derived**): `check-commit.sh` already skips the tests for 69.5 % of the commits of `main` (log, docs). Within a test-running commit, 87 % of test time sits in tests that start the built CLI (cli and property+cli: 912.7 + 36.4 of 1091.6 s at one worker, from `data/category-times.csv`), and these tests read `dist/`, so a module-graph selection of test files cannot see which of them a source change affects. That limits any file-level selection to about 13 % of test time (**derived**).

## Spurious failures

Question: how likely is it that at least one of N commits fails for a reason unrelated to the commit, so that the per-commit check stops and a rerun is needed? `scripts/spurious.mjs` computes 1 - (1 - p)^k, with k test-running commits among the N and each such commit failing independently with probability p. The independence assumption is **modelled** and the values of p come from four sources:

1. The random-id flake: 0.035 % per run of the issues package (**modelled**, earlier section; only commits that run issues are exposed, and every test-running mode runs issues).
2. An illustrative 1 % per test-running commit, to show the shape (not an estimate).
3. 0 failures in 51 package runs at the default worker count and at 2 to 8 workers (**measured**, `data/packages.csv`). The one-sided 95 % upper bound is 1 - 0.05^(1/51) = 5.7 % per package run (**derived**). It says the data cannot exclude 5.7 %; a rate that high is unlikely given 0 of 51.
4. CI reruns that passed: 36 of the 454 completed CI runs (7.9 %, **derived**). An upper bound, because a rerun need not follow a spurious failure.

Probability of at least one spurious failure over N commits, in percent (`data/spurious.csv`). Left block: every commit runs tests (a branch of package commits, k = N). Right block: a typical branch, where 30.5 % of the commits run tests (k = 0.305 N, expected value, **modelled**).

| p per test-running commit | N=1 | N=2 | N=5 | N=10 | N=20 | | N=1 | N=2 | N=5 | N=10 | N=20 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.035 % (id flake) | 0.04 | 0.07 | 0.18 | 0.35 | 0.71 | | 0.01 | 0.02 | 0.05 | 0.11 | 0.22 |
| 1 % (illustrative) | 1.00 | 1.99 | 4.90 | 9.56 | 18.21 | | 0.31 | 0.61 | 1.52 | 3.02 | 5.95 |
| 5.7 % (95 % bound, 0 of 51) | 5.70 | 11.08 | 25.45 | 44.42 | 69.11 | | 1.78 | 3.52 | 8.57 | 16.40 | 30.11 |
| 7.9 % (CI reruns, upper bound) | 7.93 | 15.23 | 33.84 | 56.23 | 80.84 | | 2.49 | 4.92 | 11.84 | 22.27 | 39.59 |

The best supported rows are the first (a known cause, 0.2 % at N=5 on package commits) and the observation of no failure in 51 local runs. The two upper bounds are limits of what the data can show, not estimates. The cost of one spurious failure at commit k of N: the rebase stops at k, the earlier commits keep their result, and the check is repeated by hand at k before `git rebase --continue` (the documented `--reschedule-failed-exec` repeats it automatically), so the extra cost is one repeat of commit k, at most 281 s, and not a restart of the branch. Restarting the whole rebase after a failure repeats every commit before k.

## What the pinned tools offer

Versions are those pinned in the repository: vitest 5.0.5, TypeScript 7.0.2, pnpm 12.15.0, tsdown 0.23.1, git 2.50, GitHub Actions. The vitest documentation site shows the latest version (5.1.0 at the time of writing, from `npm view vitest dist-tags`), so each vitest claim was also checked in the 5.0.5 package (`npm pack vitest@5.0.5`, searching `dist/`). **Measured** or **derived** as marked; "effect" is an estimate of the gain for per-commit verification, not a measurement of the feature.

| Capability | Version | Documentation | Status in the repository | Effect on per-commit cost |
|---|---|---|---|---|
| `vitest --changed [since]`, `vitest related <files>` (tests whose static imports reach the changed files) | vitest 5.0.5 (option present in `dist/`) | [CLI](https://vitest.dev/guide/cli) | Not used. `check-commit.sh` selects by package | Little: 87 % of test time is in tests that start the built CLI, which the import graph does not link to `src` (**derived**). Usable only for the 13 % of unit, git and property tests |
| `experimental.recordDependencies` (records modules each test file loads and uses them for `--changed` and `--related`; a file without a record always runs) | vitest 5.0.5 (`dist/` has the option and its description) | [CLI](https://vitest.dev/guide/cli) | Not used | Could see modules loaded in the test's own process, not in the CLI children it spawns. Experimental. Not evaluated here |
| `vitest run --last-failed` | Not in 5.0.5 (no match in `dist/`); documented for the latest version | [CLI](https://vitest.dev/guide/cli) | Not available at the pinned version | After a failure, would rerun only failed tests. Needs a vitest upgrade, which this investigation does not change |
| `--shard=i/n` with blob reports and `--merge-reports` | vitest 5.0.5 (`shard` in `dist/`) | [Improving performance](https://vitest.dev/guide/improving-performance) | Not used. CI splits by package (matrix), not by shard | Splits test files across machines. In CI it can cut a package's wall time. For a local per-commit check on one 8-core host it adds nothing, since the workers already use the cores |
| Module cache across runs (`fsModuleCache`, on by default) and `NODE_COMPILE_CACHE` | vitest 5.0.5 (`fsModuleCache` in `dist/`, `NODE_COMPILE_CACHE` in `dist/`) | [Improving performance](https://vitest.dev/guide/improving-performance) | Default on locally. Not tried: `NODE_COMPILE_CACHE`; the CLI children start fresh | The docs say the gain is largest for reruns of few files; for full suites parallelism hides it. Expected small here. Not measured |
| `isolate: false`, `pool: threads`, `fileParallelism` | vitest 5.0.5 | [Improving performance](https://vitest.dev/guide/improving-performance) | Not set | Not evaluated; a test configuration change is outside this investigation |
| `tsc -b` with `composite` and `incremental` (`.tsbuildinfo`) | TypeScript 7.0.2 (`tsc --help` lists `--build`; the options are in the [tsconfig reference](https://www.typescriptlang.org/tsconfig/)) | [tsconfig](https://www.typescriptlang.org/tsconfig/) | Used (`tsBuildInfoFile` under `dist/types`, project references in `tsconfig.json`), then removed by `check-commit.sh`, which runs `rm -rf packages/*/dist` before the build | The clean build costs 2.0 s against 0.9 s warm (**measured**, phases table), so keeping `dist/` would save about 1 s a commit (0.4 % of a 280 s check) and give up the guarantee that stale output cannot hide a missing export |
| tsdown incremental or build cache | 0.23.1 | The documentation page could not be fetched; the installed package's `dist/` has no incremental or cache option (grep) | No cache configured (`clean` only removes bundles) | None available. The build is 2 s in total anyway |
| pnpm `--filter "...[<since>]"`, `--test-pattern`, `--changed-files-ignore-pattern` | pnpm 12.15.0 (since v12.7.0 `<since>` compares against the merge base) | [Filtering](https://pnpm.io/filtering) | `ci.yml` uses the changed filter for `select`; `check-commit.sh` reimplements selection per commit to add `test-inputs.txt` | Same package selection as now. No further saving; the filter also knows nothing about `test-inputs.txt` |
| GitHub Actions matrix (`fail-fast`, `max-parallel`) | Actions | [Run job variations](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations) | Used: one `test (<package>)` job per package, `fail-fast: false` | Runs packages in parallel on separate runners. A matrix of commits (one job per commit) would test every commit in parallel; it costs the machine time of all N commits but not their wall time (derived, not tried) |
| GitHub Actions dependency caching | Actions | [Dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) | Used for pnpm (`cache: pnpm` in `setup-node`) | Saves install time only; install is 0.6 s here, so little. Entries unused for 7 days are removed |
| Merge queue (`merge_group` event) | GitHub | [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Not used; `ci.yml` triggers on `pull_request` and `push` to `main` only | Tests the pull request on top of the latest `main` and of those ahead of it, so it handles main movement (46 % of work branches, derived). It does not test each commit, and the merge method can be "rebase", which keeps the history linear |
| `git rebase --exec`, `--autosquash`, `--update-refs` | git 2.50 | [git-rebase](https://git-scm.com/docs/git-rebase/2.50.0) | `--exec scripts/check-commit.sh` is the documented workflow | With `--autosquash`, the exec runs only at the end of each squash or fixup series, so fixups are checked once as the final commit, not as intermediate states (documented behaviour). `--exec` implies `--empty=keep` |

Not found in the vitest, pnpm or git documentation for these versions (**derived** from the pages read above): a way to reuse a passing result for a commit whose tree under a package is unchanged. The investigation measured that `reword` rewrites commits whose tree is unchanged (see the section on rewritten and tree-changed commits), so a result cache keyed by tree hash would have to be built, for example in `check-commit.sh`. A caching idea is a recommendation topic and is left to the options section.

### Earlier attempts in the repository

**Source**: `git log` and `docs/issues/`. All were completed. The history shows no attempt that was abandoned.

| Date | Change | What it did | Source |
|---|---|---|---|
| 2026-10-22 | `a211ea6` ci: test affected packages on pull requests | CI selects packages from the changed files | `.github/workflows/ci.yml` history |
| 2026-10-25 | `7acd69a` build: add a per-commit check that tests only what changed | First `scripts/check-commit.sh`. Replay of phase 2b: 29 minutes instead of 63 (33 commits), 2a: 12 instead of 27, "catching the same re-created failures as the full gate". Every non-docs commit still builds from an empty `dist/` because CLI tests spawn the built binary | commit message |
| 2026-10-25 | `0798891` docs: use the per-commit check script in AGENTS.md | Names the script, so nobody "falls back to the full gate for speed or skips the check because it seems too slow" | commit message |
| 2026-10-26 | `47c22a5` build: run tests that read docs when those docs change | Adds `scripts/test-inputs.txt` and a lint that keeps it complete. Reason: a docs-only commit broke a test and still passed, which breaks `git bisect` | commit message, `scripts/check-test-inputs.mjs` |
| 2026-10-27 | `b107f71` build: check docs/issues commits with issues verify, not every test | The decision-log rule applied to `docs/issues` | commit message |
| 2026-10-28 | `f335273` build: install issues' hooks in ark and check its index per commit | Checks the committed index per commit | commit message |
| 2026-10-29 | Issue `wedm13pe` "make the test suites faster" (closed as `4dbdabf`), child `688fexss` | Cut git processes per operation: issues suite 182.8 s to 149.6 s, adr 102.5 s to 81.9 s locally. Notes the suites spawn about 214,000 git processes and 2,000 CLI processes | `docs/issues/items/wedm13pe-make-the-test-suites-faster.md`, `docs/issues/events/688fexss/` |
| 2026-10-29 | Issue `7n5e4nkf` "keep every test file under its package's per-worker share" | `scripts/check-test-durations.mjs` and file splits: `write.index.test.ts` 255 s to 53 s in 9 slices | `docs/issues/items/7n5e4nkf-*.md` |
| 2026-10-29 | `fc6837c` ci: run each package's tests in its own job; 2026-10-30 `85d78b1` run on the arm runner with 6 workers | CI parallelism by package; "about 20 % faster" on the issues tests | `.github/workflows/ci.yml`, issue `5z5rsn65` as cited there |
| 2026-10-30 | Issue `0vckaxpf`, `d0a9a26` split the issues MCP tests | Further duration splits | commit history |

The earlier work cut the cost of a run (fewer tests per commit, faster tests) and made the check cheaper to skip safely. None of it changed how many commits are checked. The numbers in the first row's message (63 to 29 minutes, 33 commits) are the author's reported measurements, not reproduced here; the 29 minutes for 33 commits gives 53 s per commit, which falls in the range of the 400-commit mean (78 s) and of the log-heavy 100-commit window (21 s).

## Options

Nothing here changes a CI job, a test, a test configuration or a dependency. The only code added is the prototype wrapper `scripts/check-commit-cached.sh`, which wraps `scripts/check-commit.sh` and leaves it untouched, and the scripts that measure and model it.

### The cheapest experiment: a tree-hash result cache

`scripts/check-commit-cached.sh` is used as the command of `git rebase --exec` in place of `scripts/check-commit.sh`. The key is the sha256 of the tree hash of the commit, the tree hash of its parent, the selection (the lines that `check-commit.sh` prints for the commit before it runs anything, obtained by running the real script with a stub `pnpm` that stops it after the selection), the versions of node, pnpm and git, the hash of `pnpm-lock.yaml` and the hash of `scripts/check-commit.sh`. A result is written only when `check-commit.sh` exits 0. A run with uncommitted or untracked files bypasses the cache. Entries are files in a scratch directory (`CACHE_DIR`), one per key. `CACHE_MODE=refresh` ignores hits and rewrites them (the periodic full run), `ro` reads only. A second, looser key without the parent tree is written beside each result so one populated cache serves the loose-key runs; it is used only by the `-loose` cells.

`scripts/cache-experiment.sh` runs it on the grid of the cost section: it populates a cache with one cold `first` run, then starts each operation from a copy of that populated cache, so one operation does not help the next. The window is the old one (`data/window.txt`), N=5 holds one issues-package commit (about 170 s) and four log commits, N=10 adds one adr, issues and ledger commit (about 270 s) and four more log commits. Runs were serial on the host above. Raw: `data/cache/` (`cache-cells.csv`, `logs/<cell>.tsv` with one line per commit: hit or miss and its seconds, `ops/<cell>.jsonl` per-commit rows from the grid scripts). All numbers in the next table are **measured**: median wall over the repeats, with the number of repeats. "Uncached" is the median of the earlier grid cells of the same operation and N (`data/ops-cells.csv`).

| N | Operation | Repeats | Hits | Misses | Rewritten | Tree changed | Cached wall (s) | Uncached wall (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | first, cold cache | 1 | 0 | 5 | 0 | 0 | 181.9 | 174.4 |
| 5 | first, run again | 3 | 5 | 0 | 0 | 0 | 1.0 (1.0 to 1.0) | 174.4 |
| 5 | reword-mid | 3 | 5 | 0 | 3 | 0 | 1.0 (1.0 to 1.0) | 175.4 |
| 5 | reorder (swap 2 and 3), strict key | 3 | 3 | 2 | 4 | 1 | 9.6 (9.5 to 9.7) | 175.3 |
| 5 | reorder (swap 2 and 3), key without parent tree | 3 | 4 | 1 | 4 | 1 | 5.3 (5.2 to 5.3) | 175.3 |
| 5 | reorder-at4 (swap 4 and 5), strict key | 1 | 3 | 2 | 2 | 1 | 170.5 | 174.2 |
| 5 | fixup-last | 3 | 4 | 1 | 1 | 1 | 169.1 (165.9 to 169.8) | 174.6 |
| 5 | fixup-mid | 1 | 2 | 3 | 3 | 3 | 174.5 | 174.9 |
| 5 | fixup-first | 1 | 0 | 5 | 5 | 5 | 183.0 | 175.0 |
| 5 | rebase onto newer main | 1 | 0 | 5 | 5 | 5 | 182.8 | 175.0 |
| 10 | first, cold cache | 1 | 0 | 10 | 0 | 0 | 471.1 | 462.3 |
| 10 | first, run again | 3 | 10 | 0 | 0 | 0 | 2.0 (1.9 to 2.0) | 462.3 |
| 10 | reword-mid | 3 | 10 | 0 | 6 | 0 | 2.0 (2.0 to 2.0) | 467.2 |
| 10 | reorder (swap 5 and 6), strict key | 1 | 8 | 2 | 6 | 1 | 173.3 | 466.3 |
| 10 | reorder (swap 5 and 6), key without parent tree | 3 | 8 | 2 | 6 | 1 | 171.1 (170.6 to 171.5) | 466.3 |
| 10 | fixup-last (last commit is a log commit) | 1 | 9 | 1 | 1 | 1 | 6.4 | not measured |
| 10 | fixup-first | 1 | 0 | 10 | 10 | 10 | 477.2 | 467.6 |
| 10 | rebase onto newer main | 1 | 0 | 10 | 10 | 10 | 476.9 | 462.5 |

What the table says:

- **A repeat and a reword cost 1.0 s at N=5 and 2.0 s at N=10**, 0.13 s per hit (**measured**, `logs/*.tsv`), against 174 to 175 s and 462 to 467 s uncached. Machine time of a repeat at N=5 is 1.1 s (user plus system), against 1150 s uncached (**derived** from `cache-cells.csv`). All 5 (N=5) and all 10 (N=10) commits hit in each of the 3 repeats of both operations, and the second run of the same branch reported all hits, as the verification asked.
- **A rebase onto newer main and a fixup of the first commit gain nothing**, they miss every commit, because every tree changes. They cost 4.5 % (N=5) and 2 to 3 % (N=10) more than uncached: 1 s of selection probing and `pnpm -v` per miss. The cold first run costs the same 4.3 % and 1.9 % extra. That overhead is the whole price of the cache when it never hits.
- **A fixup of the last commit** hits all commits but the changed one. At N=5 the changed commit is the issues-package commit, so the saving is 3 % (the heavy commit has to be checked), at N=10 it is a log commit and the run takes 6.4 s. The saving of any rewrite is the cost of the commits that hit, so it depends on whether the changed commits are heavy.
- **A reorder** misses the two swapped commits when the parent tree is in the key (strict), and when the parent tree is left out the second swapped commit still missed at N=10. The reason is **derived** from the logs: after the swap, the commit that now comes second has the same tree as the original second commit, but the diff against its new parent differs, so check-commit.sh selects other steps ("packages changed: issues" for a commit that was a log commit before), so the selection part of the key differs. Only at N=5 (two log commits swapped) did leaving the parent tree out save a miss (5.3 s against 9.6 s). Strictness costs little here and avoids a wrong hit (see the gap analysis).
- Failed runs are not cached: the N=2 reorder of the old window exits 1 at the first replayed commit and misses again on the second repeat (`cn02-reorder-r1` and `r2` in `cache-cells.csv`, `failed` = 1 each, **measured**).
- The rewritten column is not the quantity that matters: reword-mid rewrote 3 (N=5) and 6 (N=10) commits and every one hit. The tree-changed column predicts the misses (1 changed tree gives 1 or 2 misses, 0 gives none).

### How a cache weakens "every commit passes"

Today, `check-commit.sh` run on commit k states: this commit, as it stands, with this parent, built from an empty `dist/` with the installed tools, passed all selected tests in one run. A cache replaces "passed in this run" with "passed in some earlier run for an equal key". Each gap, what it needs, and what closes it:

| Gap | What happens | Is it in the prototype? | What catches it |
| --- | --- | --- | --- |
| Tree equal, parent differs | `verify --base` and the selection read the diff against the parent. A commit with the same tree on another parent can be a different change (and can fail) | Closed: the parent tree and the selection are in the key. The reorder cells show it working (the swapped commit missed). The loose key hits where the strict key misses (N=5 reorder) and is the wrong thing to use in general | Key includes the parent tree and the selection. Tip pull request CI checks the final state either way |
| Tests that read git history | A test that runs `git log` or reads tags and the commit count sees history, not the tree. The same tree on a different history can pass or fail. The tests spawn git processes heavily (about 214,000 per suite run, issue `wedm13pe`), but whether any depends on history above the tree was not audited | Not closed. The key holds one parent tree, not the history | Tip CI. A periodic full run (`CACHE_MODE=refresh`). An audit of the tests for history reads, which this investigation did not do |
| Tool drift | A new node, pnpm, git, dependency or `check-commit.sh` changes the result for the same tree | Closed for node, pnpm, git, the lockfile hash and the script hash. Not for the OS, the vitest cache, environment variables (locale, `TZ`, `ARK_*`), the registry (the install is frozen, so little) | Version-keyed entries (done), a periodic refresh, CI as a cross-check |
| A flaky pass cached | A commit that passed by luck (0.035 % random-id flake, perhaps more) is never checked again, so a failing commit can carry an entry forever | Not closed. Only exit 0 is written, so a flaky failure never enters the cache, but a flaky pass does | Periodic refresh. Tip CI. Entries expire after an age. Fixing the flakes |
| `dist/` and `node_modules` state | A hit skips the install and the clean build, so these are left as the last real check left them, not as this commit has them. The next miss runs its own install and clean build, so a miss is not affected. Only a person who reads `dist/` after a rebase sees the wrong state | Not a gap for the check; the wrapper leaves a stale `dist/` behind after a hit | Run `pnpm build` after a rebase that ended on a hit, as today after any rebase |
| Stale key, hash collision, shared store | A key that misses an input (a file the script reads outside the tree, such as `scripts/test-inputs.txt`, which is in the tree) or a store shared by people with other tool versions | The tree covers the files; the versions are in the key. A shared store needs a trust model (who may write) | Keep the store local, or write entries only from CI; check that entries match CI results |
| Reorder where the tree differs | Not a gap. A reorder changes the tree of the first commit replayed and its parent, so it is always a miss, and a reorder of dependent commits fails the check as measured | Closed by construction | The check itself |
| Selection depends on the diff against the parent | The selection can differ for equal trees (a log commit becomes a package commit after a reorder). A key without the selection would reuse a result of a check that ran fewer steps | Closed: the selection is in the key. At N=10 it turned a would-be hit into a miss | Selection in the key |

Net effect, **derived**: the cache is as safe as the equality "same tree, same parent tree, same selection, same tools implies same result", which holds for any test that is a function of the tree and the tools. It fails for tests that read history, time, the network, the environment or randomness. The residual risk is a commit that passes by cache but would fail on a fresh run. It is bounded by the flake rate of one earlier run for each hit and by the unaudited history reads. Tip CI (a fresh run of the final state in every pull request, **measured** as how CI works today) catches a wrong hit at the tip only; a wrong hit in the middle of the branch stays visible only to `git bisect`, which is what the per-commit check exists to protect. The mitigations in order of cost: version keys (done, free), write only on exit 0 (done), tip CI (exists), a cron or merge-time job that reruns the check with `CACHE_MODE=refresh` over the last merged commits (about 78 s per commit of `main`, modelled), and a CI step that compares the commits the cache says passed with a CI run of the same trees.

### Model for the options

All rows are in `data/options.csv` (one row per option, scenario, operation and N, written by `scripts/options-model.mjs`; summary in `data/options-summary.csv`). Basis of every row is in its `basis` column; this section repeats it.

**Inputs.** Per commit cost classes of the last 400 commits of `main` (`affected-share-400-summary.csv`, **measured**): docs 0.6 s (11.3 %), log 5.0 s (58.3 %), issues only 170.7 s (8.3 %), adr and issues 263.6 s (6.5 %), all packages 280.8 s (15.7 %). Mean 78.4 s per commit (**derived**), 247.2 s per test-running commit. Scenario `mixed` draws commits from all classes. Scenario `test-running` draws only from the three test-running classes (the worst realistic case, a branch of package commits). N: 1, 2, 5 (median work branch), 10, 17 (p90) and 20. The fixed part is 0: the intercepts of the pk fits are -7.8, -18.2, 0.9 and -8.8 s, within the noise of a two-point fit (**derived**). Every operation costs N times the mean before the option (**measured**: every operation costs the same as `first`), so before = 78.4 N.

**Other parameters.** Cache hit 0.13 s and miss overhead 1.0 s (**measured**, above). Misses of a rewrite: rebase and fixup-first N, fixup-last 1, reorder 2, reword and repeat 0 (**measured** at N=5 and 10, generalised). The cost of a miss is the class mean, so the modelled saving of `fixup-last` (80 % at N=5) is higher than the measured 3 % of the cell above, where the changed commit is the heavy one; either can happen. Finer selection removes 13 % of test time at most (**derived**: 87 % of test time is in tests that start the built CLI) times the test share of the check time (96 %). 8 workers instead of 7 saves 3.5 % of test time (**measured**: 272.3 s against 262.8 s, **derived** percentage). Incremental build saves 1.1 s per non-docs commit (**measured**: clean 2.01 s against warm 0.92 s). Repeatability: the expected seconds spent repeating a spurious failure, at 0.035 % per test-running commit (**modelled**, the id flake) and at 5.7 % (the 95 % upper bound of 0 failures in 51 runs, **derived**). CI factor 1.8 (**derived**: CI issues job 295 s against 164 s here); one full CI test run is 508 runner seconds (**measured** medians, 295 + 169 + 44). Merged pull requests per day 4.6 (**derived**: 105 in 23 days). Session mix for the payback (**modelled**): one first verification, then 1.14 rewrites per branch (**measured** force pushes per work branch), of which 40 % rebase, 20 % fixup-last, 20 % reword, 10 % reorder, 10 % fixup-first.

**Assumptions that the reader should challenge.** The options are modelled as independent unless the dependency table says otherwise. Finer selection is an upper bound, and the real gain is unknown. `verify-touched` assumes that unchanged patch-ids stay valid after a rebase, which the per-commit check exists to test. The CI matrix has no queueing and no runner start-up time. The merge queue's tip run is taken as the full 508 runner seconds. Lazy verification assumes a bisect range of 100 commits and 7 probes.

### Wall time over N, per operation

Wall seconds of the verification pass after the option, **modelled** (mixed scenario) unless the option row says derived. "No change" is the before value. `fixup-first` equals `rebase` except for "Verify touched commits only" (78 s at every N) and the merge queue (rebase only). Lazy verification costs 0 s locally by definition; its deferred cost is below.

#### First verification of a branch

| Option | 1 | 2 | 5 | 10 | 17 | 20 |
|---|---|---|---|---|---|---|
| No change | 78 | 157 | 392 | 784 | 1332 | 1567 |
| Tree-hash cache | 79 | 159 | 397 | 794 | 1349 | 1587 |
| Finer selection (upper bound) | 69 | 137 | 343 | 686 | 1166 | 1372 |
| 8 workers | 76 | 152 | 379 | 758 | 1288 | 1515 |
| Incremental build | 77 | 155 | 387 | 774 | 1316 | 1548 |
| Seeds, timeouts (0.035 %) | 78 | 157 | 392 | 783 | 1332 | 1567 |
| Seeds, timeouts (5.7 % bound) | 74 | 148 | 370 | 741 | 1259 | 1482 |
| Verify touched commits only | 78 | 157 | 392 | 784 | 1332 | 1567 |
| CI matrix per commit | 141 | 237 | 396 | 478 | 501 | 503 |
| Merge queue | 78 | 157 | 392 | 784 | 1332 | 1567 |
| Lazy (bisect time) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Cache + finer + 8 workers | 67 | 135 | 336 | 673 | 1144 | 1346 |

#### Rebase onto newer main

| Option | 1 | 2 | 5 | 10 | 17 | 20 |
|---|---|---|---|---|---|---|
| No change | 78 | 157 | 392 | 784 | 1332 | 1567 |
| Tree-hash cache | 79 | 159 | 397 | 794 | 1349 | 1587 |
| Finer selection (upper bound) | 69 | 137 | 343 | 686 | 1166 | 1372 |
| 8 workers | 76 | 152 | 379 | 758 | 1288 | 1515 |
| Incremental build | 77 | 155 | 387 | 774 | 1316 | 1548 |
| Seeds, timeouts (0.035 %) | 78 | 157 | 392 | 783 | 1332 | 1567 |
| Seeds, timeouts (5.7 % bound) | 74 | 148 | 370 | 741 | 1259 | 1482 |
| Verify touched commits only | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| CI matrix per commit | 141 | 237 | 396 | 478 | 501 | 503 |
| Merge queue | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Lazy (bisect time) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Cache + finer + 8 workers | 67 | 135 | 336 | 673 | 1144 | 1346 |

#### Reword

| Option | 1 | 2 | 5 | 10 | 17 | 20 |
|---|---|---|---|---|---|---|
| No change | 78 | 157 | 392 | 784 | 1332 | 1567 |
| Tree-hash cache | 0.1 | 0.3 | 0.7 | 1.3 | 2.2 | 2.6 |
| Finer selection (upper bound) | 69 | 137 | 343 | 686 | 1166 | 1372 |
| 8 workers | 76 | 152 | 379 | 758 | 1288 | 1515 |
| Incremental build | 77 | 155 | 387 | 774 | 1316 | 1548 |
| Seeds, timeouts (0.035 %) | 78 | 157 | 392 | 783 | 1332 | 1567 |
| Seeds, timeouts (5.7 % bound) | 74 | 148 | 370 | 741 | 1259 | 1482 |
| Verify touched commits only | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| CI matrix per commit | 141 | 237 | 396 | 478 | 501 | 503 |
| Merge queue | 78 | 157 | 392 | 784 | 1332 | 1567 |
| Lazy (bisect time) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Cache + finer + 8 workers | 0.1 | 0.3 | 0.7 | 1.3 | 2.2 | 2.6 |

#### Fixup of the last commit

| Option | 1 | 2 | 5 | 10 | 17 | 20 |
|---|---|---|---|---|---|---|
| No change | 78 | 157 | 392 | 784 | 1332 | 1567 |
| Tree-hash cache | 79 | 80 | 80 | 80 | 82 | 82 |
| Finer selection (upper bound) | 69 | 137 | 343 | 686 | 1166 | 1372 |
| 8 workers | 76 | 152 | 379 | 758 | 1288 | 1515 |
| Incremental build | 77 | 155 | 387 | 774 | 1316 | 1548 |
| Seeds, timeouts (0.035 %) | 78 | 157 | 392 | 783 | 1332 | 1567 |
| Seeds, timeouts (5.7 % bound) | 74 | 148 | 370 | 741 | 1259 | 1482 |
| Verify touched commits only | 78 | 78 | 78 | 78 | 78 | 78 |
| CI matrix per commit | 141 | 237 | 396 | 478 | 501 | 503 |
| Merge queue | 78 | 157 | 392 | 784 | 1332 | 1567 |
| Lazy (bisect time) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Cache + finer + 8 workers | 67 | 67 | 68 | 68 | 69 | 70 |

#### Reorder of two commits

| Option | 1 | 2 | 5 | 10 | 17 | 20 |
|---|---|---|---|---|---|---|
| No change | n/a | 157 | 392 | 784 | 1332 | 1567 |
| Tree-hash cache | n/a | 159 | 159 | 160 | 161 | 161 |
| Finer selection (upper bound) | n/a | 137 | 343 | 686 | 1166 | 1372 |
| 8 workers | n/a | 152 | 379 | 758 | 1288 | 1515 |
| Incremental build | n/a | 155 | 387 | 774 | 1316 | 1548 |
| Seeds, timeouts (0.035 %) | n/a | 157 | 392 | 783 | 1332 | 1567 |
| Seeds, timeouts (5.7 % bound) | n/a | 148 | 370 | 741 | 1259 | 1482 |
| Verify touched commits only | n/a | 157 | 157 | 157 | 157 | 157 |
| CI matrix per commit | n/a | 237 | 396 | 478 | 501 | 503 |
| Merge queue | n/a | 157 | 392 | 784 | 1332 | 1567 |
| Lazy (bisect time) | n/a | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Cache + finer + 8 workers | n/a | 135 | 135 | 136 | 136 | 137 |

The same for a branch of test-running commits (scenario `test-running`, N=5 and 17, before = 1236 s and 4202 s):

#### Test-running, first verification

A rebase costs the same except for "Verify touched commits only" and the merge queue, which cost 0 s.

| Option | 5 | 17 |
|---|---|---|
| No change | 1236 | 4202 |
| Tree-hash cache | 1241 | 4219 |
| Finer selection (upper bound) | 1078 | 3667 |
| 8 workers | 1194 | 4058 |
| Incremental build | 1230 | 4183 |
| Seeds, timeouts (0.035 %) | 1235 | 4200 |
| Seeds, timeouts (5.7 % bound) | 1165 | 3962 |
| Verify touched commits only | 1236 | 4202 |
| CI matrix per commit | 504 | 505 |
| Merge queue | 1236 | 4202 |
| Lazy (bisect time) | 0.0 | 0.0 |
| Cache + finer + 8 workers | 1046 | 3558 |

#### Test-running, fixup of the last commit

| Option | 5 | 17 |
|---|---|---|
| No change | 1236 | 4202 |
| Tree-hash cache | 249 | 250 |
| Finer selection (upper bound) | 1078 | 3667 |
| 8 workers | 1194 | 4058 |
| Incremental build | 1230 | 4183 |
| Seeds, timeouts (0.035 %) | 1235 | 4200 |
| Seeds, timeouts (5.7 % bound) | 1165 | 3962 |
| Verify touched commits only | 247 | 247 |
| CI matrix per commit | 504 | 505 |
| Merge queue | 1236 | 4202 |
| Lazy (bisect time) | 0.0 | 0.0 |
| Cache + finer + 8 workers | 210 | 211 |

### What each option changes

The fixed part is 0 for every option (**derived**), so the effect is on the per-commit part and on the share of work that is avoidable. Avoidable work (**measured** counts, **derived** seconds, column `avoidable_s`): at N=5 in the mixed scenario a reword, a repeat and a fixup of the last commit repeat 392, 392 and 314 s of checks of unchanged commits, a rebase and a fixup of the first commit 0 s. At N=17 the same operations repeat 1332, 1332 and 1254 s. Only rewrites that keep the tree of most commits have avoidable work, and a rebase onto newer main has none that a tree-keyed method can see.

| Option | Fixed part | Per-commit part (mixed, before 78.4 s) | Avoidable work removed | Basis |
| --- | --- | --- | --- | --- |
| Tree-hash cache | none | 0.13 s on a hit, +1.0 s on a miss | All of it for reword, repeat, fixup-last, reorder; none for rebase and fixup-first | measured at N=5, 10; modelled for other N |
| Finer selection | none | down to 68.6 s (-12.5 %) at best | none | modelled, upper bound |
| 8 workers | none | 75.8 s (-3.3 %) | none | derived |
| Incremental build | none | 77.5 s (-1.1 s) | none | derived |
| Seeds, timeouts | none | 78.4 to 74.0 s (the expected repeat of a spurious failure: 0.03 to 4.5 s) | none | modelled |
| Verify touched commits only | none | 78.4 s for each touched commit, 0 for the others | all except touched commits, including rebase | modelled |
| CI per-commit matrix | none | unchanged per commit; wall is the slowest commit | none (machine time is spent in CI) | modelled |
| Merge queue | none | unchanged | the rebase onto moved main (46 % of work branches, **derived**) | modelled |
| Lazy verification | none | 0 until a bisect | all, deferred | modelled |

### Break-even, dependencies and adoption cost

Break-even N is the smallest N at which the wall time after is lower than before, from `data/options-summary.csv` (**modelled**; "never" means the overhead is never repaid for that operation). Payback is the working days until the saving of the modelled session (N=5 and N=17, mixed) equals the effort at 8 hours per person-day and 4.6 branches per day; the effort figures are estimates (**modelled**) and the saving counts waiting time as equal to working time.

| Option | Break-even N (first, rebase, reword) | Session at N=5 and N=17, before to after (s) | Payback in days (N=5, N=17) | Depends on | Effort (person-days) | CI spend | Tooling | Developer workflow |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tree-hash cache | never, never, 1 | 839 to 660, 2851 to 2156 | 106, 27 | none | 2 to 4 | 0, plus an optional cross-check job | script, cache directory or git notes | none for the author; entries may hide a flake |
| Finer selection | 1, 1, 1 | 839 to 734, 2851 to 2495 | 603, 177 | none; works with the cache | 5 to 15 | 0 | vitest related, changed or recordDependencies, kept in step with `test-inputs.txt` | none; a missed test is a silent gap |
| 8 workers | 1, 1, 1 | 839 to 811, 2851 to 2756 | 23, 7 | none | 0.1 | 0 (CI has 4 cores and 6 workers) | one flag in `check-commit.sh` | none; host dependent |
| Incremental build | 1, 1, 1 | 839 to 828, 2851 to 2816 | 457, 134 | none | 0.5 to 1 | 0 | edit `check-commit.sh` | stale output can hide a missing export |
| Seeds, timeouts (5.7 % bound) | 1, 1, 1 | 839 to 793, 2851 to 2695 | 274, 81 | none | 1 to 3 | 0 | test fixes outside this investigation | none |
| Verify touched commits only | never, 1, 1 | 839 to 437, 2851 to 1377 | 24, 6 | a store of verified patch-ids | 1 to 2 | 0 | notes or a file of patch-ids | people verify only what they touched; main movement is not rechecked locally |
| CI matrix per commit | 6, 6, 6 | 839 to 846, 2851 to 1072 | none at N=5, 5 at N=17 | none; with a cache it gets cheaper | 1 to 2 | (N-1) more checks per push, 564 runner s at N=5 and 2257 at N=17 | workflow change | wait for CI instead of the local run |
| Merge queue | never, 1, never | 839 to 660, 2851 to 2244 | 27, 8 | none | 0.5 to 1 | one tip run per merge, up to 508 runner s | branch rule and `merge_group` trigger | queue wait |
| Lazy verification | 1, 1, 1 | 839 to 0, 2851 to 0, deferred | see below | a bisect script; the bisect needs buildable commits | 1 | 0 | bisect runner of `check-commit.sh` | no per-commit assurance at merge |
| Cache + finer selection + 8 workers | 1, 1, 1 | 839 to 559, 2851 to 1828 | not computed | the parts | sum of the parts | 0 | sum | sum |

Lazy verification, **modelled**: a bisect over 100 commits takes 7 probes of 247 s (test-running commits), 1730 s. The eager session costs 839 s at N=5 and 2851 s at N=17 (mixed), so lazy is cheaper while fewer than 0.48 bisect sessions per branch (N=5) or 1.65 (N=17) are needed. For test-running branches the thresholds are 1.5 and 5.2. The cost that lazy hides is that a commit that does not build or pass is found by the bisect, not at the branch, which is the failure per-commit verification was built to prevent (commit `47c22a5`: a docs-only commit that broke a test and still passed).

Dependencies between options (**derived** from how they work):

- Tree cache, finer selection, 8 workers, incremental build and the repeatability fixes are independent and multiply, so a cache plus the run-time options bring the modelled session at N=5 (mixed) to 559 s against 839 s.
- Verify touched and the cache save the same work for reword, fixup and reorder; verify touched also skips the rebase and gives up the guarantee that commits are valid on the new base. The cache does not do that, so the cache is a way to get most of verify touched for rewrites that keep trees, without the loss, but gets nothing for a rebase.
- The CI matrix needs the cache or a CI-side store to avoid its extra (N-1) test runs on repeated pushes; without it, 4.6 branches a day at N=5 spend 564 extra runner seconds each push.
- The merge queue replaces re-verification after main moves, and only helps together with a per-commit check that runs before the branch is rebased; it does not check commits itself.
- Lazy verification replaces all the others for the per-commit check, and needs the tip check (CI) and a bisect that can build every commit.
- Repeatability fixes reduce the cost of the cache's flaky-pass risk and of the cost of rerun; they are a precondition for a safe cache or a CI cross-check.

What the data cannot say: whether any test depends on git history above the tree, the real gain of finer selection beyond the 13 % bound, the size of main movement in the paths a rebase touches (a key built from the tested scope instead of the full tree could hit across a rebase onto docs-only main commits, but 30.5 % of main commits run tests, so for 5 or more moved commits a rebase would be mostly a miss anyway, **modelled**), and CI wall time on the actual runners.

## To be added in later parts

- A recommendation (to be added).

## Reproducing

See `scripts/README.md`. Every table above is regenerated by `node scripts/summarize.mjs --data data` from the raw files in `data/`.
