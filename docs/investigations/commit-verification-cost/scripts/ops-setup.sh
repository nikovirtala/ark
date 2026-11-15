#!/usr/bin/env bash
# Prepares a scratch clone for the branch-cost measurements: refs for the window of real commits
# (data/window.txt) and a "newer main" made of three later real docs commits replayed onto c0.
#
# Usage: ops-setup.sh <scratch-clone>      (a clone of ark with the window's commits in its history)
# Refs created in the clone: ops-c0 ... ops-c20 (window), ops-base (= ops-c0), ops-newmain (ops = OPS_PFX).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
win=${OPS_WIN:-$here/../data/window.txt}
PFX=${OPS_PFX:-ops}
clone=${1:?usage: ops-setup.sh <scratch-clone>}
cd "$clone"
git config user.name measure && git config user.email measure@example.invalid
export GIT_COMMITTER_DATE="2026-11-15T00:00:00Z"
git checkout -q --detach
while read -r name sha _; do
  case $name in c[0-9]*) git branch -f "$PFX-$name" "$sha" ;; esac
done <"$win"
git branch -f $PFX-base $PFX-c0
git checkout -q --detach $PFX-c0
while read -r name sha _; do
  [ "$name" = m ] && git cherry-pick "$sha" >/dev/null
done <"$win"
git branch -f $PFX-newmain HEAD
git checkout -q --detach $PFX-c0
git log --oneline $PFX-base..$PFX-newmain
