#!/usr/bin/env bash
# Runs the cells of the branch-cost grid in a fixed order, resumably, within a time budget.
# Cells already in ops-cells.csv are skipped; a cell is started only if its estimated cost still
# fits in the budget, so a call with a hard time cap can be repeated until the grid is done.
#
# Usage: run-grid.sh --repo CLONE --plan PLAN --budget SECONDS [--out DIR]
#   PLAN lines: "<n> <op> <rep>" (blank lines and # comments allowed)
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=$here/../data repo="" plan="" budget=1500
while [ $# -gt 0 ]; do
  case $1 in
  --repo) repo=$2; shift ;; --plan) plan=$2; shift ;; --budget) budget=$2; shift ;; --out) OUT=$2; shift ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
start=$(date +%s)
# OPS_ISSUES_COST overrides the 171 s used for an issues-only commit (window pk: about 300 s).
# Estimated seconds for a verification of the first N window commits (data/window.txt modes;
# per-mode costs from check-commit.csv: docs 0.6, log 5, issues 171, adr+issues 264, all 281).
estimate() {
  awk -v n="$1" -v ic="${OPS_ISSUES_COST:-171}" '
    /^c[0-9]+ / { i = substr($1, 2) + 0; if (i == 0 || i > n) next
      m = ""; for (f = 2; f <= NF; f++) if ($f ~ /^mode=/) m = substr($f, 6)
      c = (m == "docs") ? 0.6 : (m == "log") ? 5 : (m == "pkg:issues") ? ic : (m == "pkg:adr+issues") ? 264 : 281
      t += c }
    END { print int(t + 5 * n) }' "${OPS_WIN:-$here/../data/window.txt}"
}
while read -r n op rep; do
  case $n in "" | "#"*) continue ;; esac
  cell=$(printf '%sn%02d-%s-r%s' "${OPS_TAG:-}" "$n" "$op" "$rep")
  if [ -f "$OUT/ops-cells.csv" ] && grep -q "^$cell," "$OUT/ops-cells.csv"; then continue; fi
  est=$(estimate "$n")
  elapsed=$(($(date +%s) - start))
  if [ $((elapsed + est + 30)) -gt "$budget" ]; then echo "budget: $cell needs about ${est}s, ${elapsed}s used; stopping"; exit 3; fi
  "$here/run-branch-op.sh" --repo "$repo" --n "$n" --op "$op" --rep "$rep" --out "$OUT" || true
done <"$plan"
echo "plan finished"
