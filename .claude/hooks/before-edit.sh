#!/usr/bin/env sh
# Before-edit hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as `<tool> hooks agent before-edit`.
# That subcommand does not exist in the pinned published versions (adr 0.5.10 /
# issues 0.5.6), so this script calls the existing `adr for <path>` and
# `issues for <path>` commands, which report the decisions and open issues that
# govern the file about to be edited. Keep the pins in step with .mcp.json.
#
# The harness passes the tool-call event as JSON on stdin; pull the edited path from
# it. Claude Code uses tool_input.file_path; fall back to any "*path" string.
set -eu

ADR="npx -y @nikovirtala/adr@0.5.10"
ISSUES="npx -y @nikovirtala/issues@0.5.6"

EVENT="$(cat 2>/dev/null || true)"
PATH_EDITED="$(printf '%s' "$EVENT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"

# Nothing to look up without a path; let the edit proceed.
[ -n "$PATH_EDITED" ] || exit 0

$ADR for "$PATH_EDITED" 2>/dev/null || true
$ISSUES for "$PATH_EDITED" 2>/dev/null || true
