#!/usr/bin/env bash
# Runs the result-cache experiment on one branch size: check-commit-cached.sh as the per-commit
# command of the grid cells of run-branch-op.sh. Serial, resumable.
#
# Usage: cache-experiment.sh --repo CLONE --cache-root DIR --n N [--ops "rebase reword-mid ..."] [--reps R]
#   --repo        scratch clone prepared with ops-setup.sh and built (window "ops", data/window.txt)
#   --cache-root  where the cache directories live (scratch, not in the repository)
#   --ops         operations to run after the cache is populated (default: first rebase reword-mid
#                 reorder fixup-last fixup-first); "first" here is the second run, all hits expected
#   --reps        repeats per operation (default 1)
# Steps per N: (1) "populate" = first-run with an empty cache (all misses) unless the cache for N exists,
# (2) each operation starts from a copy of that populated cache, so operations do not help each other.
# Output in data/cache/: cache-cells.csv (one row per cell), ops/ and ops-cells.csv (same as the grid),
# logs/<cell>.tsv (one line per commit: sha, tree, hit|miss|bypass, key, exit, seconds).
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=$here/../data/cache
repo="" root="" n="" ops="first rebase reword-mid reorder fixup-last fixup-first" reps=1
while [ $# -gt 0 ]; do
  case $1 in
  --repo) repo=$2; shift ;; --cache-root) root=$2; shift ;; --n) n=$2; shift ;; --ops) ops=$2; shift ;;
  --reps) reps=$2; shift ;; --out) OUT=$2; shift ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$repo" ] && [ -n "$root" ] && [ -n "$n" ] || { echo "usage: see header" >&2; exit 2; }
mkdir -p "$OUT/logs" "$root"
export OPS_CHECK=$here/check-commit-cached.sh CACHE_MODE=rw
base=$root/n$n-populated

run_cell() { # run_cell <cache-dir> <op> <rep> <kind>; op "X-loose" is X with the parent tree left out of the key
  local cell real=${2%-loose} src
  cell=$(printf 'cn%02d-%s-r%s' "$n" "$2" "$3")
  [ "$4" = populate ] && cell=$(printf 'cn%02d-populate-r0' "$n") && real=first
  if [ -f "$OUT/cache-cells.csv" ] && grep -q "^$cell," "$OUT/cache-cells.csv"; then echo "skip $cell"; return; fi
  export CACHE_DIR=$1 CACHE_LOG=$OUT/logs/$cell.tsv
  case $2 in *-loose) export CACHE_NOPARENT=1 ;; *) unset CACHE_NOPARENT ;; esac
  rm -f "$CACHE_LOG"
  RESUME=0 OPS_TAG=c "$here/run-branch-op.sh" --repo "$repo" --n "$n" --op "$real" --rep "$3" --out "$OUT" || true
  src=$(printf 'cn%02d-%s-r%s' "$n" "$real" "$3")
  node "$here/cache-summary.mjs" "$OUT" "$src" "$cell" "$CACHE_LOG"
}

if [ ! -d "$base" ]; then
  rm -rf "$base.tmp"; mkdir -p "$base.tmp"
  run_cell "$base.tmp" first 0 populate
  mv "$base.tmp" "$base"
fi
for op in $ops; do
  for r in $(seq 1 "$reps"); do
    d=$root/n$n-$op-r$r
    rm -rf "$d"; cp -r "$base" "$d"
    run_cell "$d" "$op" "$r" run
    rm -rf "$d"
  done
done
