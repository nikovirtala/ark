# Measurement scripts

These scripts take the measurements behind `../findings.md` and write raw data to `../data/`. They change nothing in the repository except the files in `data/`.

## Requirements

- Node 24 on the PATH and the repository built: `source ~/.nvm/nvm.sh; nvm use 24; pnpm install --frozen-lockfile; pnpm build`.
- Bash, git, and a Linux host. The scripts read bash's `time` for wall, user and system seconds.
- Network access to the npm registry for the empty-store install phase (`COLD_INSTALL=0` skips it) and for `npx markdownlint-cli2`.

Run every script from a checkout. They locate the repository with `git rev-parse`, so a worktree works too. Logs go to `.agents/measure-logs/` (git-ignored) unless `--log-dir` says otherwise.

## Scripts

| Script | What it does | Output in `data/` |
|---|---|---|
| `measure.sh` | Times the phases of a verification run (install, lint, typecheck, build warm and clean, adr and issues verify and index checks, markdownlint), each package's tests at the default worker count, and a worker sweep | `phases.csv`, `packages.csv`, `reports/<package>-w<workers>-r<run>.json`, `host.txt`, `measured-commit.txt` |
| `check-commit-modes.sh` | Times `scripts/check-commit.sh` for one commit of each kind (docs, log, adr, issues, ledger, workspace), using an uncommitted edit in a scratch worktree | `check-commit.csv` |
| `categorize.mjs` | Sorts test files into unit, git, cli and property categories and sums the vitest report times per category and per file | `file-categories.csv`, `category-times.csv`, `file-times.csv` |
| `summarize.mjs` | Prints median and range tables from the files above, and the failing tests found in the reports | stdout, saved as `summary.txt` |
| `id-zzz-estimate.mjs` | Estimates how often a random subject id contains `zzz` (the cause of one flaky test) | stdout, saved as `id-zzz-estimate.json` |
| `lib.sh` | Shared `timed` helper and host facts | none |

CSV columns end with `wall_s,user_s,sys_s,exit`: elapsed seconds, user CPU seconds, system CPU seconds of the command and its children, and the exit status. Machine time is `user_s + sys_s`.

## Reproduce the tables

```sh
source ~/.nvm/nvm.sh; nvm use 24
export RESUME=1                      # skip rows already recorded; safe to rerun after a timeout
D=docs/investigations/commit-verification-cost
$D/scripts/measure.sh --phases --repeats 3
$D/scripts/measure.sh --packages --repeats 5
$D/scripts/measure.sh --sweep --workers "1 2 4 6 8 16" --repeats 3
$D/scripts/check-commit-modes.sh --repeats 3
node $D/scripts/id-zzz-estimate.mjs 20000000 > $D/data/id-zzz-estimate.json
node $D/scripts/categorize.mjs
node $D/scripts/summarize.mjs --data $D/data --track "lets a proposed decision name code" > $D/data/summary.txt
```

Run time on the measured host (8 cores): phases about 1 minute per repeat, packages about 4.5 minutes per repeat, the worker sweep about 3 hours for all counts, `check-commit-modes.sh` about 17 minutes per repeat.

## Cost over the number of commits

`run-branch-op.sh` measures one cell (a branch of N real commits, one operation, then `git rebase --exec scripts/check-commit.sh`), `run-grid.sh` runs the cells of a plan within a time budget and skips cells already in `data/ops-cells.csv`, and `fit-cost.mjs` derives the tables. `ops-setup.sh` creates the refs of a window in a scratch clone that has the commits and has been installed and built. Windows: `data/window.txt` (default, refs `ops-*`, mostly logs), `data/ops-window.txt` (`OPS_PFX=pk OPS_TAG=pk-`, package commits) and `data/ops-window-pair.txt` (`OPS_PFX=pr OPS_TAG=pr-`, an independent pair). `OPS_ISSUES_COST` sets the per-commit estimate the grid uses for its budget (300 for the pk window).

```sh
source ~/.nvm/nvm.sh; nvm use 24
D=docs/investigations/commit-verification-cost; R=<scratch clone>
OPS_WIN=$PWD/$D/data/ops-window.txt OPS_PFX=pk $D/scripts/ops-setup.sh $R
export RESUME=1 OPS_WIN=$PWD/$D/data/ops-window.txt OPS_PFX=pk OPS_TAG=pk- OPS_ISSUES_COST=300
$D/scripts/run-grid.sh --repo $R --plan $D/data/ops-plan-pk.txt --budget 1700   # repeat until "plan finished"
$D/scripts/run-branch-op.sh --repo $R --n 2 --op alone-2 --rep 1                # one commit checked alone
node $D/scripts/fit-cost.mjs                                                     # fit.csv and the other tables
```

Plans: `ops-plan.txt` (old window, N=1 to 5), `ops-plan-large.txt` (old window, N=10 and 20), `ops-plan-pk.txt`, `ops-plan-pair.txt`, `ops-plan-breaks.txt` (time to first failure). Operations are listed in the header of `run-branch-op.sh`. Run cells serially: parallel runs distort timing. Wall time per cell is the per-commit cost times N (about 300 s per package commit in the pk window, about 4 s per log commit).

## Quick mode

`measure.sh --quick` runs one repeat of the phases and the adr tests, about 2 minutes. Use `--out <dir>` to keep a quick run apart from the real data:

```sh
$D/scripts/measure.sh --quick --out /tmp/quick --log-dir /tmp/quick-logs
node $D/scripts/categorize.mjs --data /tmp/quick
node $D/scripts/summarize.mjs --data /tmp/quick
```

## Caveats

- `RESUME=1` matches rows by run, package and workers. Delete a row (and its report) to measure it again. One chunk of the 4-worker sweep ran twice before the resume match was fixed; the CSV keeps the later row of each pair, which matches the report on disk.
- A test run that fails still gets a row (exit not 0) and its report. `summarize.mjs` lists the failing tests.
- Absolute times belong to the measured host. Compare ratios, not seconds, across machines.
