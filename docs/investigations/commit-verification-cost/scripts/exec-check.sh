#!/usr/bin/env bash
# The command `git rebase --exec` runs after each commit: scripts/check-commit.sh, timed, with one
# JSON line per commit appended to $OPS_JSONL (see ops-record.mjs). Exit status is the check's.
# Environment: OPS_CHECK (command to run, default scripts/check-commit.sh), OPS_JSONL, OPS_CELL, OPS_LOGS (log dir), OPS_T0 (epoch seconds, start of the run).
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${OPS_JSONL:?}" "${OPS_CELL:?}" "${OPS_LOGS:?}" "${OPS_T0:?}"
seq=$(($(cat "$OPS_LOGS/$OPS_CELL.seq" 2>/dev/null || echo 0) + 1))
echo "$seq" >"$OPS_LOGS/$OPS_CELL.seq"
log=$OPS_LOGS/$OPS_CELL-$seq.log
t_in=$(date +%s.%N)
TIMEFORMAT='%3R,%3U,%3S'
tf=$(mktemp)
{ time ${OPS_CHECK:-scripts/check-commit.sh} >"$log" 2>&1; rc=$?; } 2>"$tf" || true
t=$(tail -n 1 "$tf")
rm -f "$tf"
t_out=$(date +%s.%N)
node "$here/ops-record.mjs" "$OPS_JSONL" "$OPS_CELL" "$seq" "$log" "$t" "$rc" "$t_in" "$t_out" "$OPS_T0"
exit "$rc"
