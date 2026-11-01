#!/usr/bin/env sh
# Kiro session-start hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as `<tool> hooks agent session-start`,
# with `doctor --fix-clone` first. Neither exists in the pinned published versions
# (adr 0.6.0 / issues 0.6.0); doctor arrives in a later slice. Until then this runs
# the equivalent commands the pinned CLIs expose: `hooks install` installs any missing
# git hooks in this clone (the `--fix-clone` part), then each tool lists what changed
# since the last session and `issues ready` lists pickable work. The Claude copy of
# this script is .claude/hooks/session-start.sh; keep the two in step.
set -eu

ADR="npx -y @nikovirtala/adr@0.6.0"
ISSUES="npx -y @nikovirtala/issues@0.6.0"

$ADR hooks install >/dev/null 2>&1 || true
$ISSUES hooks install >/dev/null 2>&1 || true

SINCE="$(git rev-parse --quiet --verify 'origin/main' 2>/dev/null || echo 'HEAD~1')"
$ADR list --since "$SINCE" 2>/dev/null || true
$ISSUES list --since "$SINCE" 2>/dev/null || true
$ISSUES ready 2>/dev/null || true
