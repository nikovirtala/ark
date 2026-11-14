#!/usr/bin/env bash
# Measures one cell of the branch-cost grid: a branch of N real commits (data/window.txt), one
# operation on it, then the per-commit verification of AGENTS.md ("git rebase --exec
# scripts/check-commit.sh <base>"), with per-commit timing written as JSON lines.
#
# Usage: run-branch-op.sh --repo CLONE --n N --op OP [--rep R] [--out DIR] [--logs DIR]
#   OP: first | rebase | fixup-first | fixup-mid | fixup-last | reword-mid | reorder | reorder-atK
#       reorder              swaps commits N/2 and N/2+1; reorder-atK swaps K and K+1
#       break-build-first|mid|last   a commit that fails to compile     (time to first failure)
#       break-test-first|mid|last    a commit with a failing test       (time to first failure)
#   The clone must have been prepared with ops-setup.sh and built (pnpm install && pnpm build).
# Output: <out>/ops/<cell>.jsonl (one line per checked commit), <out>/ops-cells.csv (one line per cell),
#         <out>/ops/<cell>.rewrite.json (commits before and after). RESUME=1 skips finished cells.
#   cell = nNN-OP-rR
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=$here/../data
repo="" n="" op="" rep=1 logs=""
while [ $# -gt 0 ]; do
  case $1 in
  --repo) repo=$2; shift ;; --n) n=$2; shift ;; --op) op=$2; shift ;; --rep) rep=$2; shift ;;
  --out) OUT=$2; shift ;; --logs) logs=$2; shift ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$repo" ] && [ -n "$n" ] && [ -n "$op" ] || { echo "usage: see header" >&2; exit 2; }
cell=$(printf 'n%02d-%s-r%s' "$n" "$op" "$rep")
mkdir -p "$OUT/ops"
logs=${logs:-$repo/../ops-logs}
mkdir -p "$logs"
jsonl=$OUT/ops/$cell.jsonl
csv=$OUT/ops-cells.csv
if [ "${RESUME:-0}" = 1 ] && [ -f "$csv" ] && grep -q "^$cell," "$csv"; then echo "skip $cell"; exit 0; fi
cd "$repo" || exit 1
# The identity goes in the clone's own config, not in GIT_* variables: those would reach the tests
# (a test of "assignee me" needs a missing git identity) and fail them.
git config user.name measure && git config user.email measure@example.invalid
git config core.editor true && git config sequence.editor true
rm -f "$jsonl" "$logs/$cell".*

# Fresh state: branch "work" at cN, clean tree.
git rebase --abort >/dev/null 2>&1
git checkout -q -f --detach ops-c0 && git clean -fdq -e node_modules -e dist
git branch -f work "ops-c$n" && git checkout -q work
k_first=1 k_last=$n k_mid=$(((n + 1) / 2))

snapshot() { # snapshot <base> <file>: JSON list of commits base..HEAD with tree, patch-id and message hash
  node -e '
    const { execFileSync: x } = require("node:child_process");
    const g = (a, i) => x("git", a, { encoding: "utf8", input: i }).trim();
    const [base, file] = process.argv.slice(1);
    const shas = g(["rev-list", "--reverse", `${base}..HEAD`]).split("\n").filter(Boolean);
    const rows = shas.map((s) => ({
      sha: s.slice(0, 12), tree: g(["rev-parse", `${s}^{tree}`]).slice(0, 12),
      patch: (g(["patch-id", "--stable"], x("git", ["diff-tree", "-p", "--no-ext-diff", "--root", s], { encoding: "utf8", maxBuffer: 1 << 28 })).split(" ")[0] || "empty").slice(0, 12),
      msg: g(["hash-object", "--stdin"], g(["log", "-1", "--format=%B", s])).slice(0, 12),
      subject: g(["log", "-1", "--format=%s", s]),
    }));
    require("node:fs").writeFileSync(file, JSON.stringify(rows, null, 1));' "$1" "$2"
}

nth() { git rev-list --reverse ops-base..HEAD | sed -n "${1}p"; }

# A change to a file the commit touched and no later commit in the branch touches, so the fixup applies.
pick_file() { # pick_file <k> -> file path on stdout
  local sha later f
  sha=$(nth "$1")
  # files touched after commit k within the branch
  later=$(git log --name-only --format= "$sha..HEAD" | sort -u)
  for f in $(git diff-tree --no-commit-id --name-only -r --diff-filter=AM "$sha"); do
    case $f in */index.md) continue ;; esac
    echo "$later" | grep -qxF "$f" && continue
    echo "$f"
    return 0
  done
  return 1
}

touch_file() { # touch_file <file>: append a harmless line the way the file's type allows
  case $1 in
  *.yaml) printf '# reviewed\n' >>"$1" ;;
  *.ts) printf '// reviewed\n' >>"$1" ;;
  *.json) return 1 ;;
  *.md) printf '\nReviewed.\n' >>"$1" ;;
  *) printf '# reviewed\n' >>"$1" ;;
  esac
}

now() { date +%s.%N; }
op_t0=$(now)
base=ops-base
snapshot ops-base "$OUT/ops/$cell.pre.json"
TIMEFORMAT='%3R,%3U,%3S'
tf=$(mktemp)
ok=1
case $op in
first) ;;
rebase)
  git rebase ops-newmain >"$logs/$cell.op.log" 2>&1 || ok=0
  base=ops-newmain ;;
fixup-first | fixup-mid | fixup-last)
  case $op in fixup-first) k=$k_first ;; fixup-mid) k=$k_mid ;; fixup-last) k=$k_last ;; esac
  f=$(pick_file "$k") || { echo "$cell: no file to fix up in commit $k" >&2; ok=0; }
  if [ "$ok" = 1 ]; then
    touch_file "$f" && git add "$f" && git commit -q --no-verify --fixup="$(nth "$k")" &&
      git rebase -q -i --autosquash ops-base >"$logs/$cell.op.log" 2>&1 || ok=0
  fi ;;
reword-mid)
  git -c core.editor="sed -i '1s/\$/ (reworded)/'" -c sequence.editor="sed -i '${k_mid}s/^pick/reword/'" rebase -q -i ops-base >"$logs/$cell.op.log" 2>&1 || ok=0 ;;
reorder | reorder-at*)
  a=$((n / 2))
  case $op in reorder-at*) a=${op#reorder-at} ;; esac
  if [ "$n" -lt 2 ] || [ "$a" -lt 1 ] || [ "$a" -ge "$n" ]; then echo "$cell: no pair to reorder" >&2; ok=0
  else
    git -c sequence.editor="sed -i -e '${a}{h;d}' -e '$((a + 1)){G}'" rebase -q -i ops-base >"$logs/$cell.op.log" 2>&1 || ok=0
  fi ;;
break-*)
  kind=${op#break-} kind=${kind%%-*}
  case ${op##*-} in first) k=$k_first ;; mid) k=$k_mid ;; last) k=$k_last ;; esac
  case $kind in
  build) printf 'export const brokenByMeasurement: number = "x";\n' >packages/issues/src/zz-broken.ts ;;
  test) printf 'import { expect, test } from "vitest";\ntest("broken by measurement", () => { expect(1).toBe(2); });\n' >packages/issues/src/zz-broken.test.ts ;;
  esac
  git add packages/issues/src && git commit -q --no-verify --fixup="$(nth "$k")" &&
    git rebase -q -i --autosquash ops-base >"$logs/$cell.op.log" 2>&1 || ok=0 ;;
*) echo "unknown op $op" >&2; exit 2 ;;
esac
op_wall=$(awk -v a="$(now)" -v b="$op_t0" 'BEGIN{printf "%.3f", a-b}')
if [ "$ok" = 0 ]; then
  git rebase --abort >/dev/null 2>&1
  echo "$cell,$n,$op,$rep,op_failed,,,,,,,,,," >>"$csv"
  echo "$cell: operation failed (see $logs/$cell.op.log)"; exit 1
fi
snapshot "$base" "$OUT/ops/$cell.post.json"

# The verification pass, as AGENTS.md says to run it.
export OPS_JSONL=$jsonl OPS_CELL=$cell OPS_LOGS=$logs OPS_T0=$(now)
{ time git rebase --exec "$here/exec-check.sh" "$base" >"$logs/$cell.rebase.log" 2>&1; rc=$?; } 2>"$tf" || true
t=$(tail -n 1 "$tf"); rm -f "$tf"
git rebase --abort >/dev/null 2>&1
git checkout -q -f --detach ops-c0 && git clean -fdq -e node_modules -e dist

node "$here/ops-cell.mjs" "$csv" "$cell" "$n" "$op" "$rep" "$op_wall" "$t" "$rc" "$jsonl" "$OUT/ops/$cell.pre.json" "$OUT/ops/$cell.post.json"
tail -n 1 "$csv"
