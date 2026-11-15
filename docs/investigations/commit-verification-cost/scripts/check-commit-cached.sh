#!/usr/bin/env bash
# Prototype: a result cache around scripts/check-commit.sh. Use it as the command of
# `git rebase --exec`. It does not change check-commit.sh.
#
# A commit that was checked before with the same key is not checked again. The key is the sha256 of:
#   tree hash of HEAD, tree hash of the parent (verify --base reads the parent),
#   the selection (what check-commit.sh would run for this commit, obtained by running the real script
#   with a stub pnpm that stops it right after it prints the selection), node, pnpm and git versions,
#   the hash of pnpm-lock.yaml and the hash of scripts/check-commit.sh.
# A result is stored only when check-commit.sh exits 0. A failure is never cached.
# A second, looser key (without the parent tree) is stored too, for the experiment.
#
# Environment:
#   CACHE_DIR      directory with one file per key (default: $(git rev-parse --git-dir)/check-cache)
#   CACHE_MODE     rw (default), ro (read, never write), refresh (ignore hits, write), off (no cache)
#   CACHE_LOG      file that gets one tab-separated line per commit: sha, tree, hit|miss|bypass, key, exit, seconds
#   CACHE_NOPARENT 1 looks results up by a key without the parent tree (looser; see findings.md). Both keys
#                  are always written.
# Arguments are passed on to check-commit.sh.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
mode=${CACHE_MODE:-rw}
dir=${CACHE_DIR:-$(git rev-parse --git-dir)/check-cache}
sha=$(git rev-parse HEAD)
tree=$(git rev-parse 'HEAD^{tree}')
t0=$(date +%s.%N)

log() { # log <hit|miss|bypass> <key> <exit>
  [ -n "${CACHE_LOG:-}" ] || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${sha:0:12}" "${tree:0:12}" "$1" "${2:0:12}" "$3" \
    "$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.3f", a-b}')" >>"$CACHE_LOG"
}

run() { scripts/check-commit.sh "$@"; }

if [ "$mode" = off ]; then
  run "$@"; rc=$?; log bypass - "$rc"; exit "$rc"
fi
# Uncommitted or untracked files make the tree hash say nothing about what is checked.
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  run "$@"; rc=$?; log bypass - "$rc"; exit "$rc"
fi

stub=$(mktemp -d)
trap 'rm -rf "$stub"' EXIT
printf '#!/bin/sh\nexit 99\n' >"$stub/pnpm" && chmod +x "$stub/pnpm"
# Selection lines, with the sha removed so equal selections of different commits compare equal.
selection=$(PATH="$stub:$PATH" scripts/check-commit.sh "$@" 2>&1 | grep '^check-commit: ' |
  grep -v '^check-commit: lint:' | sed -E 's/^check-commit: [0-9a-f]{7,40}: /check-commit: /')
parent=none
git rev-parse -q --verify 'HEAD~1^{tree}' >/dev/null && parent=$(git rev-parse 'HEAD~1^{tree}')
common=$({
  echo "selection=$selection"; echo "args=$*"
  echo "node=$(node -v)"; echo "pnpm=$(pnpm -v 2>/dev/null)"; echo "git=$(git --version)"
  echo "lock=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
  echo "script=$(sha256sum scripts/check-commit.sh | cut -d' ' -f1)"
})
# Two keys are written for every result so one populated cache serves both modes.
key_strict=$({ echo "tree=$tree"; echo "parent=$parent"; echo "$common"; } | sha256sum | cut -d' ' -f1)
key_loose=$({ echo "tree=$tree"; echo "$common"; } | sha256sum | cut -d' ' -f1)
key=$key_strict
[ -n "${CACHE_NOPARENT:-}" ] && key=$key_loose

if [ "$mode" != refresh ] && [ -f "$dir/$key" ]; then
  # Replay the selection lines so logs and ops-record.mjs see the mode, then report the hit.
  echo "$selection" | sed -E "s/^check-commit: /check-commit: ${sha:0:7}: /"
  echo "check-commit-cached: hit $key (checked before at $(sed -n 's/^when=//p' "$dir/$key"), took $(sed -n 's/^seconds=//p' "$dir/$key") s)"
  log hit "$key" 0
  exit 0
fi

run "$@"; rc=$?
if [ "$rc" -eq 0 ] && [ "$mode" != ro ]; then
  mkdir -p "$dir"
  secs=$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.1f", a-b}')
  for k in "$key_strict" "$key_loose"; do
    printf 'commit=%s\ntree=%s\nseconds=%s\nwhen=%s\nnode=%s\n' "$sha" "$tree" "$secs" "$(date -u +%FT%TZ)" "$(node -v)" >"$dir/$k.tmp" &&
      mv "$dir/$k.tmp" "$dir/$k"
  done
fi
echo "check-commit-cached: miss $key exit $rc"
log miss "$key" "$rc"
exit "$rc"
