#!/usr/bin/env bash
# Prepares a scratch clone for the branch-cost measurements: refs for the window of real commits
# (data/window.txt) and a "newer main" made of three later real docs commits replayed onto c0.
#
# Usage: ops-setup.sh <scratch-clone>      (a clone of ark with the window's commits in its history)
# Refs created in the clone: ops-c0 ... ops-c20 (window), ops-base (= ops-c0), ops-newmain.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
win=$here/../data/window.txt
clone=${1:?usage: ops-setup.sh <scratch-clone>}
cd "$clone"
git config user.name measure && git config user.email measure@example.invalid
export GIT_COMMITTER_DATE="2026-11-15T00:00:00Z"
git checkout -q --detach
while read -r name sha _; do
  case $name in c[0-9]*) git branch -f "ops-$name" "$sha" ;; esac
done <"$win"
git branch -f ops-base ops-c0
git checkout -q --detach ops-c0
while read -r name sha _; do
  [ "$name" = m ] && git cherry-pick "$sha" >/dev/null
done <"$win"
git branch -f ops-newmain HEAD
git checkout -q --detach ops-c0
git log --oneline ops-base..ops-newmain
