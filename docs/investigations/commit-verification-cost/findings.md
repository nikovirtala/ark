# What verifying every commit of a branch costs

Status: draft, part 1 of 3. This part covers the stack, the workflow, a single verification run, where its time goes, and how reproducible it is. The cost curve over the number of commits, what drives it, and the options and recommendation are added in later parts and are marked "to be added" below.

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

## To be added in later parts

- The cost of verifying N commits: the curve over N, and what moves it (to be added).
- Options that change the curve and a recommendation (to be added).
- A model of the cost for a branch of N commits of mixed kinds, built from the per-kind costs above (to be added; labelled **modelled**).

## Reproducing

See `scripts/README.md`. Every table above is regenerated by `node scripts/summarize.mjs --data data` from the raw files in `data/`.
