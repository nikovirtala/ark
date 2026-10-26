#!/usr/bin/env bash
# Per-commit check for `git rebase --exec scripts/check-commit.sh origin/main` (AGENTS.md).
# Checks HEAD against a base (default HEAD~1, the parent inside `git rebase --exec`) and runs only
# the steps that the changed files can affect. Run by hand: `scripts/check-commit.sh [base]`;
# with a base, it checks everything since the merge base, including uncommitted and untracked files.
#
#   only *.md outside docs/adr/, docs/issues/ and    -> lint
#     packages/*/src/ that no test reads
#   a file listed in scripts/test-inputs.txt          -> its own row, plus tests of the packages
#                                                        that read it and their dependents
#   docs/adr/ or docs/issues/ (no package or          -> lint, install, build, adr verify,
#     workspace files)                                   issues verify
#   packages/<p>/                                     -> the above + tests of <p> and its dependents
#   anything else, a root or merge commit, no base    -> the above + every package's tests
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse --short HEAD)
t_start=$(date +%s)

say() { echo "check-commit: $*"; }

# step <name> <reason> <command...>
step() {
  local name=$1 reason=$2
  shift 2
  say "$name: $reason"
  "$@"
}

skip() { say "skip $1: $2"; }

# Resolve the base. Anything unusual gets the full check.
full=""
base=""
if [ $# -ge 1 ]; then
  if ! base=$(git merge-base "$1" HEAD 2>/dev/null); then
    full="no merge base with $1"
    base=""
  fi
else
  parents=$(($(git rev-list --parents -n 1 HEAD | wc -w) - 1))
  if [ "$parents" -eq 0 ]; then
    full="root commit"
  elif [ "$parents" -gt 1 ]; then
    full="merge commit"
  else
    base=$(git rev-parse HEAD~1)
  fi
fi

# Classify the changed files: the tree against the base, plus untracked files.
adr_log=0
issues_log=0
pkgs=""
root_files=""
add_pkg() {
  local p=${1#packages/}
  p=${p%%/*}
  case " $pkgs " in *" $p "*) ;; *) pkgs="$pkgs $p" ;; esac
}
# Repository files that tests read from disk outside their package, and the packages whose tests
# read them: scripts/test-inputs.txt, kept complete by `pnpm lint` (scripts/check-test-inputs.mjs).
test_inputs=scripts/test-inputs.txt
# readers_of <file>: the packages whose tests read <file>, one per line.
readers_of() {
  [ -f "$test_inputs" ] || return 0
  local input readers
  # Read the parse check-test-inputs.mjs does: a last line without "\n" and CRLF endings count too.
  while read -r input readers || [ -n "$input" ]; do
    readers=${readers%$'\r'}
    case $input in "" | "#"*) continue ;; esac
    case $input in
    */) [[ $1 == "$input"* ]] || continue ;;
    *) [ "$1" = "$input" ] || continue ;;
    esac
    printf '%s\n' $readers
  done <"$test_inputs"
}
if [ -z "$full" ]; then
  changed=$({
    git diff --name-only --no-renames "$base"
    git ls-files --others --exclude-standard
  } | sort -u)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    for r in $(readers_of "$f"); do
      say "$f is read by tests of $r"
      add_pkg "$r"
    done
    case $f in
    docs/adr/*) adr_log=1 ;;
    docs/issues/*) issues_log=1 ;;
    packages/*/src/*) add_pkg "$f" ;;
    # Other Markdown outside these trees: no test reads it (test-inputs.txt lists the files tests do read).
    *.md) ;;
    packages/*/*) add_pkg "$f" ;;
    # Same rule as CI: workspace-level files (lockfile, tsconfig, biome, .github, scripts, ...) affect every package.
    *) root_files="$root_files $f" ;;
    esac
  done <<<"$changed"
  if [ -n "$root_files" ]; then
    full="workspace-level files changed:$(echo "$root_files" | cut -c1-200)"
  fi
fi
pkgs=${pkgs# }

if [ -n "$full" ]; then
  mode=full
  say "$sha: full check ($full)"
elif [ -n "$pkgs" ]; then
  mode=pkg
  say "$sha: packages changed: $pkgs$([ "$adr_log" = 1 ] && echo ', plus docs/adr')$([ "$issues_log" = 1 ] && echo ', plus docs/issues')"
elif [ "$adr_log" = 1 ] || [ "$issues_log" = 1 ]; then
  mode=log
  say "$sha: logs changed ($([ "$adr_log" = 1 ] && echo 'docs/adr')$([ "$adr_log$issues_log" = 11 ] && echo ', ')$([ "$issues_log" = 1 ] && echo 'docs/issues')), no package or workspace files"
else
  mode=docs
  say "$sha: docs only (*.md outside docs/adr, docs/issues and packages/*/src) or nothing changed"
fi

step lint "every commit" pnpm lint

if [ "$mode" = docs ]; then
  skip install "docs only"
  skip build "docs only"
  skip verify "docs only"
  skip test "docs only"
  say "$sha: done in $(($(date +%s) - t_start))s ($mode)"
  exit 0
fi

step install "not docs only; makes node_modules match this commit's lockfile" pnpm install --frozen-lockfile
# Removing dist/ first means stale build output can't hide a missing export or a deleted file.
step build "CLI and e2e tests spawn the built binaries, and dependents import dependencies' dist/" \
  sh -c 'rm -rf packages/*/dist && pnpm build'

if [ -d docs/adr ]; then
  if [ -n "$base" ]; then
    step verify "check ark's decision log against $base" node packages/adr/dist/cli.js verify --base "$base"
  else
    step verify "check ark's decision log" node packages/adr/dist/cli.js verify
  fi
  if git ls-files --error-unmatch docs/adr/index.md >/dev/null 2>&1; then
    step index-check "docs/adr/index.md must match the log" node packages/adr/dist/cli.js index --check
  fi
fi

if [ -d docs/issues ]; then
  if [ -n "$base" ]; then
    step issues-verify "check ark's issue log against $base" node packages/issues/dist/cli.js verify --base "$base"
  else
    step issues-verify "check ark's issue log" node packages/issues/dist/cli.js verify
  fi
fi

case $mode in
log)
  skip test "only docs/adr or docs/issues changed"
  ;;
full)
  step test "full check: every package" pnpm -r run test
  ;;
pkg)
  filters=()
  for p in $pkgs; do filters+=(--filter "...{./packages/$p}"); done
  # "..." adds dependents (ledger -> adr -> issues). The root depends on adr for its git hooks,
  # and its test script is the whole suite, so exclude it, as CI does.
  step test "changed packages and their dependents ($pkgs)" pnpm "${filters[@]}" --filter '!ark' run test
  ;;
esac

say "$sha: done in $(($(date +%s) - t_start))s ($mode)"
