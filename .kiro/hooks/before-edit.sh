#!/usr/bin/env sh
# Kiro before-edit hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as `<tool> hooks agent before-edit`.
# That subcommand does not exist in the pinned published versions (adr 0.6.0 /
# issues 0.6.0), so this calls `adr for <path>` and `issues for <path>`, which report
# the decisions and open issues that govern the file about to be edited. The Claude
# copy of this script is .claude/hooks/before-edit.sh; keep the two in step.
#
# Kiro passes the tool-call event as JSON on stdin; its V3 write tools carry the target
# path in tool input as "path" (and some as "file_path"). Pull whichever is present.
set -eu

ADR="npx -y @nikovirtala/adr@0.6.0"
ISSUES="npx -y @nikovirtala/issues@0.6.0"

EVENT="$(cat 2>/dev/null || true)"
PATH_EDITED="$(printf '%s' "$EVENT" | sed -n 's/.*"\(file_path\|path\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' | head -n 1)"

[ -n "$PATH_EDITED" ] || exit 0

$ADR for "$PATH_EDITED" 2>/dev/null || true
$ISSUES for "$PATH_EDITED" 2>/dev/null || true
