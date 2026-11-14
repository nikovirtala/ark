#!/usr/bin/env bash
# Measures the cost of one verification run (what scripts/check-commit.sh does for one commit),
# phase by phase and package by package. Resumable: every run appends to CSV files in $OUT and
# skips work already recorded when RESUME=1.
#
# Usage (from a checkout with Node 24 on PATH):
#   scripts/measure.sh --quick              one repeat, adr package only, ~2 minutes
#   scripts/measure.sh --repeats 3          phases and per-package tests, 3 repeats
#   scripts/measure.sh --workers "1 2 4 6 8" --repeats 3   worker sweep per package
# Env: RESUME=1 skips rows already in the CSVs; COLD_INSTALL=0 skips the empty-store install.
# Options: --out DIR (default docs/investigations/commit-verification-cost/data),
#          --phases / --packages / --sweep to run one part only (default: phases and packages),
#          --pkgs "adr issues ledger", --repeats N, --workers "<list>", --log-dir DIR.
# Output files in $OUT:
#   phases.csv      run,phase,wall_s,user_s,sys_s,exit      (install, lint, build, verify, ...)
#   packages.csv    run,package,workers,wall_s,user_s,sys_s,exit
#   reports/<package>-w<workers>-r<run>.json   raw vitest JSON reports
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"
cd "$(repo_root)"
root=$PWD

OUT=$root/docs/investigations/commit-verification-cost/data
LOGS=${LOG_DIR:-$root/.agents/measure-logs}
repeats=3 pkgs="adr issues ledger" workers="" mode=all
while [ $# -gt 0 ]; do
  case $1 in
  --quick) repeats=1 pkgs="adr" mode=quick ;;
  --repeats) repeats=$2; shift ;;
  --pkgs) pkgs=$2; shift ;;
  --workers) workers=$2; shift ;;
  --out) OUT=$2; shift ;;
  --log-dir) LOGS=$2; shift ;;
  --phases) mode=phases ;;
  --packages) mode=packages ;;
  --sweep) mode=sweep ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$OUT/reports" "$LOGS"
export LOGS
host_facts >"$OUT/host.txt"
git rev-parse HEAD >"$OUT/measured-commit.txt"

done_already() { [ "${RESUME:-0}" = 1 ] && [ -f "$1" ] && grep -q "^$2" "$1"; }

phase() { # phase <run> <name> -- cmd...
  local run=$1 name=$2
  shift 3
  done_already "$OUT/phases.csv" "$run,$name," && return 0
  CSV_HEADER=run,phase timed "$OUT/phases.csv" "$run,$name" "$LOGS/phase-$run-$name.log" -- "$@"
  tail -n 1 "$OUT/phases.csv"
}

run_phases() {
  local r
  for r in $(seq 1 "$repeats"); do
    phase "$r" install-warm -- pnpm install --frozen-lockfile
    # node_modules removed, package store kept: what a CI run with a restored pnpm cache pays
    phase "$r" install-from-store -- sh -c 'rm -rf node_modules packages/*/node_modules && pnpm install --frozen-lockfile'
    # node_modules and a fresh empty store: downloads every package from the registry (needs network)
    [ "${COLD_INSTALL:-1}" = 1 ] && phase "$r" install-cold -- sh -c \
      'rm -rf node_modules packages/*/node_modules && rm -rf "$LOGS/cold-store" && pnpm install --frozen-lockfile --store-dir "$LOGS/cold-store"'
    phase "$r" lint -- pnpm lint
    phase "$r" typecheck-warm -- pnpm exec tsc -b
    phase "$r" build-warm -- pnpm build
    phase "$r" build-clean -- sh -c 'rm -rf packages/*/dist packages/*/*.tsbuildinfo tsconfig.tsbuildinfo && pnpm build'
    phase "$r" adr-verify -- node packages/adr/dist/cli.js verify
    phase "$r" adr-index-check -- node packages/adr/dist/cli.js index --check
    phase "$r" issues-verify -- node packages/issues/dist/cli.js verify
    phase "$r" issues-index-check -- node packages/issues/dist/cli.js index --check
    phase "$r" markdownlint -- npx --yes markdownlint-cli2 "**/*.md"
  done
}

pkg_run() { # pkg_run <run> <package> <workers|default>
  local run=$1 p=$2 w=$3 flag=""
  [ "$w" != default ] && flag="--maxWorkers=$w"
  done_already "$OUT/packages.csv" "$run,$p,$w," && return 0
  local rep="$OUT/reports/$p-w$w-r$run.json"
  # shellcheck disable=SC2086
  CSV_HEADER=run,package,workers timed "$OUT/packages.csv" "$run,$p,$w" "$LOGS/test-$p-w$w-r$run.log" -- \
    pnpm --filter "./packages/$p" run test $flag --reporter=json --outputFile="$rep"
  tail -n 1 "$OUT/packages.csv"
}

run_packages() {
  local r p
  for r in $(seq 1 "$repeats"); do
    for p in $pkgs; do pkg_run "$r" "$p" default; done
  done
}

run_sweep() {
  local r p w
  for w in ${workers:-1 2 4 6 8}; do
    for r in $(seq 1 "$repeats"); do
      for p in $pkgs; do pkg_run "$r" "$p" "$w"; done
    done
  done
}

case $mode in
quick) run_phases; run_packages ;;
all) run_phases; run_packages ;;
phases) run_phases ;;
packages) run_packages ;;
sweep) run_sweep ;;
esac
echo "measure: done, data in $OUT"
