#!/usr/bin/env bash
# Times scripts/check-commit.sh, the per-commit check of `git rebase --exec`, for one commit of each
# kind it distinguishes: docs only, a decision-log change, a change in one package (each of adr,
# issues, ledger; the dependents run too) and a workspace-level change (every package).
# The change is a harmless uncommitted edit in a scratch worktree, checked against the base commit
# with `scripts/check-commit.sh <base>`. Nothing is committed and the main checkout is untouched.
#
# Usage: scripts/check-commit-modes.sh [--repeats N] [--modes "docs log pkg-adr pkg-issues pkg-ledger full"]
#        [--out DIR] [--worktree DIR]       RESUME=1 skips rows already in the CSV
# Output: <out>/check-commit.csv   run,mode,wall_s,user_s,sys_s,exit
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"
root=$(repo_root)
OUT=$root/docs/investigations/commit-verification-cost/data
WT=$root/.agents/worktrees/check-commit-modes
repeats=3 modes="docs log pkg-adr pkg-issues pkg-ledger full"
while [ $# -gt 0 ]; do
  case $1 in
  --repeats) repeats=$2; shift ;;
  --modes) modes=$2; shift ;;
  --out) OUT=$2; shift ;;
  --worktree) WT=$2; shift ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$OUT" "$(dirname "$WT")"
LOGS=$root/.agents/measure-logs
mkdir -p "$LOGS"
base=$(git -C "$root" rev-parse HEAD)
if [ ! -d "$WT" ]; then git -C "$root" worktree add --detach "$WT" "$base" >/dev/null; fi
cd "$WT" || exit 1
git checkout -q --detach "$base" && git checkout -q -- . && git clean -fdq -e node_modules -e dist
pnpm install --frozen-lockfile >/dev/null 2>&1
pnpm build >/dev/null 2>&1

change() { # change <mode>: one uncommitted edit that puts check-commit.sh in that mode
  case $1 in
  docs) printf '\n' >>README.md ;;
  log) printf '\n' >>docs/adr/.gitkeep ;;
  pkg-adr) printf '// measurement edit\n' >>packages/adr/src/index.ts ;;
  pkg-issues) printf '// measurement edit\n' >>packages/issues/src/index.ts ;;
  pkg-ledger) printf '// measurement edit\n' >>packages/ledger/src/index.ts ;;
  full) printf '# measurement edit\n' >>scripts/check-fixups.sh ;;
  esac
}

for r in $(seq 1 "$repeats"); do
  for m in $modes; do
    if [ "${RESUME:-0}" = 1 ] && [ -f "$OUT/check-commit.csv" ] && grep -q "^$r,$m," "$OUT/check-commit.csv"; then continue; fi
    git checkout -q -- . && git clean -fdq -e node_modules -e dist
    change "$m"
    CSV_HEADER=run,mode timed "$OUT/check-commit.csv" "$r,$m" "$LOGS/check-commit-$m-r$r.log" -- scripts/check-commit.sh "$base"
    tail -n 1 "$OUT/check-commit.csv"
  done
done
git checkout -q -- . && git clean -fdq -e node_modules -e dist
echo "check-commit-modes: done"
