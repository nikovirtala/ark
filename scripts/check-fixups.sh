#!/bin/sh
# Fails when <base>..<head> has a fixup!, squash! or amend! commit; AGENTS.md says they never reach main.
set -eu
[ $# -eq 2 ] || { echo "usage: check-fixups.sh <base> <head>" >&2; exit 2; }
log=$(git log --format='%h %s' "$1..$2" --)   # set -e stops here on a bad range (git exits 128)
bad=$(printf '%s\n' "$log" | grep -E '^[0-9a-f]+ (fixup|squash|amend)! ' || true)
if [ -n "$bad" ]; then
  echo "squash these before merging (git rebase -i --autosquash $1):" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
