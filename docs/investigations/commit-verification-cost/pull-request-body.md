# What verifying every commit of a branch costs

This pull request adds an investigation under `docs/investigations/commit-verification-cost/`: raw data, scripts, `findings.md` and a prototype result cache around `scripts/check-commit.sh`. It changes no CI job, test, test configuration or dependency. Every number carries a label: **measured** (read from a run or the GitHub API, raw file under `data/`), **derived** (arithmetic on measured numbers) or **modelled** (an estimate from a stated assumption). Times are seconds. Machine time is user plus system CPU seconds. The host has 8 vCPU, Node 24.22.1, pnpm 12.15.0, git 2.50.1. The details and the method are in `findings.md`.

## Evidence

### One verification run

`scripts/check-commit.sh` on one commit, 3 repeats, wall and machine time (**measured**, `data/check-commit.csv`):

| Commit changes | Wall | Machine time |
|---|---|---|
| docs only | 0.6 | 2.9 |
| decision-log change | 5.0 | 13.4 |
| `issues` package only | 170.7 | 1177.5 |
| `adr` (adr and issues run) | 263.6 | 1830.0 |
| `ledger` or workspace file (all three run) | 280.8 | 1951.0 |

The fixed phases add up to 5.6 s (**derived**: install 0.6, lint 0.55, clean build 2.0, four verify and index checks 2.5), 2 % of a 280 s check. The tests are the other 98 % (**derived**: 272.3 of 280.3 s). The test time of the three packages at the default 7 workers is adr 91.0, issues 164.1 and ledger 17.3 s (**measured**, `data/packages.csv`).

### Cost over N, by operation

Every cell is a branch of N real commits of `main`, one operation applied, then `git rebase --exec scripts/check-commit.sh`. Windows: `old` (mostly log commits, one issues commit among the first five), `pk` (package commits, run before the issues test split), `pr` (an independent pair). **Measured**, medians over the repeats; raw `data/ops-cells.csv`, table `data/cost-table.csv`. Rewritten is the commits with a new sha, tree changed the commits whose tree differs. Machine time exists for every cell.

| Window | Operation | N | Repeats | Wall (range) | Machine time | Rewritten | Tree changed |
|---|---|---|---|---|---|---|---|
| old | first | 1 | 3 | 4.2 (4.1-4.2) | 11.6 | 0 | 0 |
| old | fixup-first | 1 | 3 | 4.2 (4.2-4.2) | 11.9 | 1 | 1 |
| old | rebase | 1 | 3 | 4.2 (4.2-4.2) | 11.8 | 1 | 1 |
| old | reword-mid | 1 | 3 | 4.2 (4.2-4.2) | 11.8 | 1 | 0 |
| old | first | 2 | 3 | 8.4 (8.2-8.4) | 23.8 | 0 | 0 |
| old | fixup-first | 2 | 3 | 8.4 (8.3-8.4) | 23.6 | 2 | 2 |
| old | fixup-last | 2 | 3 | 8.3 (8.3-8.4) | 23.5 | 1 | 1 |
| old | rebase | 2 | 3 | 8.4 (8.3-8.4) | 23.5 | 2 | 2 |
| old | reorder | 2 | 3 | 3.8 (3.8-3.8) | 11.2 | 2 | 2 |
| old | reword-mid | 2 | 3 | 8.3 (8.3-8.4) | 23.6 | 2 | 0 |
| old | first | 5 | 3 | 174.4 (174.0-175.4) | 1150.0 | 0 | 0 |
| old | fixup-first | 5 | 3 | 175.0 (174.3-175.2) | 1154.2 | 5 | 5 |
| old | fixup-last | 5 | 3 | 174.6 (174.5-176.1) | 1152.5 | 1 | 1 |
| old | fixup-mid | 5 | 3 | 174.9 (174.4-175.2) | 1153.1 | 3 | 3 |
| old | rebase | 5 | 3 | 175.0 (174.8-175.2) | 1152.3 | 5 | 5 |
| old | reorder | 5 | 3 | 175.3 (175.2-179.8) | 1156.0 | 4 | 1 |
| old | reorder-at4 | 5 | 3 | 174.2 (173.9-179.1) | 1147.4 | 2 | 1 |
| old | reword-mid | 5 | 3 | 175.4 (173.6-178.3) | 1156.0 | 3 | 0 |
| old | first | 10 | 1 | 462.3 (462.3-462.3) | 3081.8 | 0 | 0 |
| old | fixup-first | 10 | 1 | 467.6 (467.6-467.6) | 3136.3 | 10 | 10 |
| old | rebase | 10 | 1 | 462.5 (462.5-462.5) | 3104.2 | 10 | 10 |
| old | reorder | 10 | 1 | 466.3 (466.3-466.3) | 3130.8 | 6 | 1 |
| old | reword-mid | 10 | 1 | 467.2 (467.2-467.2) | 3135.3 | 6 | 0 |
| old | first | 20 | 1 | 987.4 (987.4-987.4) | 6685.3 | 0 | 0 |
| pk | first | 1 | 3 | 307.5 (302.4-311.8) | 1063.5 | 0 | 0 |
| pk | fixup-first | 1 | 1 | 304.7 (304.7-304.7) | 1060.2 | 1 | 1 |
| pk | rebase | 1 | 1 | 301.8 (301.8-301.8) | 1059.5 | 1 | 1 |
| pk | reword-mid | 1 | 1 | 304.5 (304.5-304.5) | 1056.6 | 1 | 0 |
| pk | first | 2 | 2 | 622.3 (619.5-625.0) | 2175.7 | 0 | 0 |
| pk | fixup-first | 2 | 1 | 608.5 (608.5-608.5) | 2162.6 | 2 | 2 |
| pk | fixup-last | 2 | 1 | 615.6 (615.6-615.6) | 2176.7 | 1 | 1 |
| pk | rebase | 2 | 1 | 621.9 (621.9-621.9) | 2174.3 | 2 | 2 |
| pk | reorder | 2 | 1 | 1.8 (1.8-1.8) | 8.4 | 2 | 1 |
| pk | reword-mid | 2 | 1 | 617.8 (617.8-617.8) | 2169.2 | 2 | 0 |
| pr | first | 2 | 1 | 319.7 (319.7-319.7) | 1412.7 | 0 | 0 |
| pr | reorder | 2 | 2 | 324.0 (323.6-324.4) | 1431.2 | 2 | 1 |

Every operation costs the same as `first` at the same N within about 3 %, because `git rebase --exec` replays and checks all N commits whatever changed. A reorder of dependent commits exits 1 at the first replayed commit (in two windows). A rewrite changes the tree of far fewer commits than it rewrites: a reword rewrites 3 of 5 and changes no tree, a reorder of two commits rewrites 4 of 5 and changes 1.

Fitted fixed and per-commit parts (`data/fit.csv`, **measured fit**):

| Window | Operation | Fixed part | Per commit | Basis |
|---|---|---|---|---|
| pk | first | -7.8 | 315.0 | 5 cells at N=1 and 2 (two values of N, so the intercept means nothing and linearity is untested) |
| pk | rebase, fixup-first, reword-mid | -18.2, 0.9, -8.8 | 320.1, 303.8, 313.3 | 2 cells each |
| old | first | -76.8 | 52.9 | 11 cells, N=1 to 20, r2 0.995; the negative intercept shows that a straight line is the wrong shape |
| old | first, by kind (**derived**) | 12.9 | 6.6 plus 173.2 per package commit | 20 running totals, r2 0.994 |

Cost is bimodal: commits that no test reads cost 0.6 to 5 s, a commit that runs package tests costs 171 to 281 s (**measured**). The pk window costs 307 s per issues commit against 160 to 171 s elsewhere (`findings.md`, Not established).

### How branches are made

Source: 108 closed pull requests collected through the GitHub API, 105 merged, of which 78 are work branches and 27 release branches (**measured**, `data/pr-summary.json`, `data/pr-branches.csv`). Percentiles over 78 branches are coarse.

| Work branches (78) | Mean | Median | p75 | p90 | Max |
|---|---|---|---|---|---|
| Commits per branch | 8.3 | 5 | 9 | 17 | 60 |
| Commits that landed on `main` while the branch was open (**derived**, estimate) | 4.8 | 0 | 6.75 | 14.6 | 39 |

67 % of work branches were force-pushed at least once (1.14 per branch on average). By size: 1 to 2 commits 61 % (mean 0.91 pushes), 3 to 5 commits 53 % (0.79), 6 to 10 commits 67 % (1.11), over 10 commits 89 % (1.83) (**measured**). 46 % of work branches saw `main` move while they were open (**derived**, low reliability: the API does not report the base at open time).

Expected cost of one per-commit verification of a branch (**modelled**: N times the mean of 78.4 s per commit over the last 400 commits of `main`, **derived**):

| Branch | N | Mixed, 78.4 s per commit | Every commit runs all tests, 280.8 s per commit |
|---|---|---|---|
| Work, median | 5 | 392 s | 1404 s |
| Work, p90 | 17 | 1333 s | 4774 s |

With 1.14 rewrites per branch, a branch costs one to 2.1 verifications (**modelled**). CI runs the tests of the tip only, one run per push.

### Spurious failures

Probability of at least one spurious failure over N commits, in percent (**modelled**: 1 - (1 - p)^k, independence assumed; `data/spurious.csv`). Left: every commit runs tests, k = N. Right: a typical branch, 30.5 % of commits run tests, k = 0.305 N.

| p per test-running commit and its source | N=5 | N=10 | N=20 | N=5 | N=10 | N=20 |
|---|---|---|---|---|---|---|
| 0.035 % (random-id flake, modelled) | 0.18 | 0.35 | 0.71 | 0.05 | 0.11 | 0.22 |
| 5.7 % (95 % upper bound of 0 failures in 51 package runs, derived) | 25.45 | 44.42 | 69.11 | 8.57 | 16.40 | 30.11 |
| 7.9 % (CI reruns that passed, 36 of 454 runs, upper bound, derived) | 33.84 | 56.23 | 80.84 | 11.84 | 22.27 | 39.59 |

0 of 51 local package runs failed (**measured**). A spurious failure at commit k costs one repeat of commit k, at most 281 s, not a restart of the branch (**derived**). CI: 76 of 454 finished runs failed (16.7 %), 39 runs were reruns and 36 of those passed; their cause is unknown (**measured**).

### Share of the suite a commit affects

Last 400 commits of `main`, classified with the `check-commit.sh` rules (**measured**, `data/affected-share-400.csv`, no difference from `data/commit-modes.csv`):

| What the commit changes | Commits | Share of the suite's test time | Check wall time | Share of all check time (**derived**) |
|---|---|---|---|---|
| Docs only | 45 (11.3 %) | 0 % | 0.6 | 0.1 % |
| Decision or issue log only | 233 (58.3 %) | 0 % | 5.0 | 3.7 % |
| Issues package only | 33 (8.3 %) | 60.3 % | 170.7 | 18.0 % |
| Adr package (adr and issues run) | 26 (6.5 %) | 93.6 % | 263.6 | 21.8 % |
| Ledger or several packages | 47 (11.7 %) | 100 % | 280.8 | 42.1 % |
| Workspace-level file | 16 (4.0 %) | 100 % | 280.8 | 14.3 % |

30.5 % of commits run tests and take 96 % of the check time. 87 % of the test time is in tests that start the built CLI, so selecting test files by import graph can remove at most 13 % (**derived**).

## Options

Wall time of one first verification at the median work branch (N=5) and the p90 one (N=17), before and after the option (**modelled** from `data/options.csv`, mixed branch, before 392 and 1332 s). The cache has measured cells at N=5 and N=10 (`data/cache/cache-cells.csv`). Adoption cost is an estimate in person-days (**modelled**).

| Option | N=5 | N=17 | Adoption cost |
|---|---|---|---|
| Tree-hash result cache, first verification or rebase | 392 to 397 | 1332 to 1349 | 2 to 4 |
| Tree-hash result cache, reword | 392 to 0.7 | 1332 to 2.2 | same |
| Tree-hash result cache, fixup of the last commit | 392 to 80 | 1332 to 82 | same |
| Tree-hash result cache, reorder of two commits | 392 to 159 | 1332 to 161 | same |
| Finer test selection (upper bound) | 392 to 343 | 1332 to 1166 | 5 to 15 |
| 8 workers instead of 7 | 392 to 379 | 1332 to 1288 | 0.1 |
| Incremental build | 392 to 387 | 1332 to 1316 | 0.5 to 1 |
| Pin seeds and timeouts (5.7 % bound) | 392 to 370 | 1332 to 1259 | 1 to 3 |
| Verify touched commits only (gives up the guarantee) | 392 to 392, rebase 0 | 1332 to 1332, rebase 0 | 1 to 2 |
| CI job per commit | 392 to 396 | 1332 to 501 | 1 to 2, plus runner time |
| Merge queue (rebase only) | rebase 392 to 0 | rebase 1332 to 0 | 0.5 to 1 |
| Lazy verification (deferred to bisect) | 392 to 0 | 1332 to 0 | 1 |

Session (a first verification plus 1.14 rewrites, **modelled**): 839 to 660 s at N=5 and 2851 to 2156 s at N=17 with the cache, 839 to 559 and 2851 to 1828 with the cache, finer selection and 8 workers together. Measured cache cells at N=5, median wall: first run again 1.0 s, reword 1.0 s, reorder (strict key) 9.6 s, fixup of the last commit 169.1 s, rebase and fixup of the first commit 182.8 and 183.0 s, against 174 to 175 s uncached.

## Recommendation

**First step:** run the per-commit check through a tree-hash result cache (`scripts/check-commit-cached.sh`, key: tree, parent tree, selection, tool versions, lockfile and script hashes; written only on exit 0). Change at the median branch (**modelled**): a session falls from 839 to 660 s (-21 %), a reword from 392 to 0.7 s; at the p90 branch the session falls from 2851 to 2156 s (-24 %). A rebase and a fixup of the first commit gain nothing and cost 3 to 5 % more (**measured**, 1 s per miss). Break-even: the first reword. Payback of 2 to 4 person-days: 106 working days at N=5 and 27 at N=17 for mixed branches (**modelled**), so the case rests on large branches and branches of package commits (33 and 8 days).

**What follows:** a scheduled refresh run (`CACHE_MODE=refresh`) over merged commits and the tip CI as today; fixes for the known flakes; a merge queue if rebases dominate; 8 workers on hosts with 8 or more cores.

**What to leave alone:** the selection and the clean build in `check-commit.sh`; finer test selection (at most 13 %, payback 603 and 177 days); verify-touched-only and lazy verification (they drop the guarantee that each commit is valid on its base); a CI job per commit; CI jobs, tests, test configuration and dependencies.

**Confirming experiment, run:** an audit of the tests for reads of git history (`scripts/audit-history-reads.sh`) and a trace of every git call made by a full run of the three suites (`scripts/trace-git-in-repo.sh`, **measured**). 1747 git calls ran inside the checkout; 0 were `log`, `rev-list`, `describe`, `show`, `tag` or `merge-base`. No test reads the history of the checkout, so equal tree, parent tree, selection and tools gave equal results in the tests audited.

## Decisions

| Decision | Source |
|---|---|
| Wrap `check-commit.sh`, do not edit it | [`scripts/check-commit.sh`](https://github.com/nikovirtala/ark/blob/main/scripts/check-commit.sh), [commit `7acd69a`](https://github.com/nikovirtala/ark/commit/7acd69a) |
| Strict key with parent tree and selection; write only on exit 0 | `data/cache/cache-cells.csv` |
| Keep the tip-only CI as the cross-check | [`.github/workflows/ci.yml`](https://github.com/nikovirtala/ark/blob/main/.github/workflows/ci.yml) |
| Keep the clean build per commit (1.1 s saved of 280 s) | `data/phases.csv` |
| No finer selection (87 % of test time starts the built CLI) | [vitest CLI](https://vitest.dev/guide/cli), `data/category-times.csv` |
| No lazy or touched-only verification | [commit `47c22a5`](https://github.com/nikovirtala/ark/commit/47c22a5) |
| No CI job per commit | [Run job variations](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations) |

## Not established

- Modelled cells: all of `data/options.csv`, the effort numbers and the payback days. To measure: the cache experiment on a real branch of 17 commits, with 3 repeats.
- N=20 for every operation except `first` (987.4 s, one repeat) is modelled. To measure: the same cells at N=20, about 17 minutes each.
- One-repeat cells: all N=10 and N=20 cells, the pk cells other than `first`, the break cells and most cache cells at N=10.
- The cause of the 36 CI reruns that passed: the API does not return the first attempt's jobs for most reruns.
- The pk window cost of 307 s per commit against 160 to 171 s elsewhere. The suggested cause (one long test file before the split of the issues tests) is inferred, not tested. To measure: per-file timings of the tests at the pk commit.
- Reads of git history by `adr verify` and `issues verify` without `--base`, and by tests under other git versions or operating systems.
- A cached flaky pass, tool drift beyond the key, and a cache shared by several people.
