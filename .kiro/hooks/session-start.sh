#!/usr/bin/env sh
# Kiro session-start hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as `<tool> hooks agent …`. That subcommand does not
# exist in the pinned published versions (adr 0.6.0 / issues 0.6.0), so this calls the commands they do have.
# `hooks install` installs any missing git hooks in this clone (the `doctor --fix-clone`
# part), then each tool lists what changed since the main ref, and `issues ready` lists pickable
# work. One `npm exec` serves every call, so a cold cache downloads once. Keep the pins in step
# with the MCP configs. Run it as `sh <this file>`: it needs no execute bit.
set -eu

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

main_ref() {
  for f in 'docs/adr/adr.toml' 'adr.toml' 'docs/issues/issues.toml' 'issues.toml'; do
    [ -f "$f" ] || continue
    b="$(sed -n 's/^[[:space:]]*main_branch[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -n 1)"
    if [ -n "$b" ] && git rev-parse --quiet --verify "$b^{commit}" >/dev/null 2>&1; then
      echo "$b"
      return
    fi
  done
  o="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  for r in "$o" refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master; do
    if [ -n "$r" ] && git rev-parse --quiet --verify "$r^{commit}" >/dev/null 2>&1; then
      echo "$r"
      return
    fi
  done
}
SINCE="$(main_ref)"

npm exec --yes --package=@nikovirtala/adr@0.6.0 --package=@nikovirtala/issues@0.6.0 -- sh -c '
adr hooks install >/dev/null 2>&1 || true
issues hooks install >/dev/null 2>&1 || true
if [ -n "$1" ]; then
  adr list --since "$1" 2>/dev/null || true
  issues list --since "$1" 2>/dev/null || true
fi
issues ready 2>/dev/null || true
' sh "$SINCE"
