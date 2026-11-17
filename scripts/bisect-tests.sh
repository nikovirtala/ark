#!/usr/bin/env bash
# Finds the first commit that breaks a test (AGENTS.md, "Finding a regression"):
#
#   cp scripts/bisect-tests.sh /tmp/
#   git bisect start <bad> <good>
#   git bisect run /tmp/bisect-tests.sh [<package>...]
#
# Per commit: install, build from an empty dist/, then the tests of the named packages (directories
# under packages/), or of every package when none is named. Name the package that fails: the full
# suite takes minutes, one package takes less.
#
# Exit codes follow git bisect run: 0 good, 1 bad (a test fails), 125 skip (the commit can't be
# installed or built, so its tests can't be judged; it says nothing about the regression).
# Always run a copy from outside the repository, as above: commits before this script was added
# don't have it, and git bisect run treats the resulting exit 127 as an error and stops. The script
# finds the repository from the current directory, which git bisect run sets to the top level.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

say() { echo "bisect-tests: $(git rev-parse --short HEAD): $*"; }

filters=(-r)
for p in "$@"; do
  [ -d "packages/$p" ] || {
    echo "bisect-tests: no package packages/$p" >&2
    exit 128 # above 127: aborts the bisect instead of marking a commit
  }
  filters+=(--filter "./packages/$p")
done

pnpm install --frozen-lockfile || {
  say "install failed; skip"
  exit 125
}
rm -rf packages/*/dist
pnpm build || {
  say "build failed; skip"
  exit 125
}

if pnpm "${filters[@]}" run test; then
  say "tests pass; good"
  exit 0
fi
say "tests fail; bad"
exit 1
