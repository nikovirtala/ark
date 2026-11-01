#!/usr/bin/env sh
# Session-start hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as `<tool> hooks agent session-start`,
# and the first step to be `doctor --fix-clone`. Neither the `hooks agent` subcommand
# nor `doctor` exists in the pinned published versions (adr 0.5.10 / issues 0.5.6);
# doctor arrives in a later slice. Until then this script runs the equivalent commands
# the pinned CLIs do expose: `hooks install` installs any missing git hooks in this
# clone (the `--fix-clone` part), then each tool lists what changed since the last
# session and `issues ready` lists pickable work. Keep the pins in step with .mcp.json.
set -eu

ADR="npx -y @nikovirtala/adr@0.5.10"
ISSUES="npx -y @nikovirtala/issues@0.5.6"

# Install git hooks if this clone is missing them (stand-in for `doctor --fix-clone`).
$ADR hooks install >/dev/null 2>&1 || true
$ISSUES hooks install >/dev/null 2>&1 || true

# What changed since the last session, and what is ready to pick up.
# --since takes a git rev; the previous main tip is a reasonable "last seen".
SINCE="$(git rev-parse --quiet --verify 'origin/main' 2>/dev/null || echo 'HEAD~1')"
$ADR list --since "$SINCE" 2>/dev/null || true
$ISSUES list --since "$SINCE" 2>/dev/null || true
$ISSUES ready 2>/dev/null || true
