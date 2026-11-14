#!/usr/bin/env sh
# Kiro protect-logs hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# Kiro keeps permission rules per person, outside the repository, so a committed PreToolUse hook
# is what refuses a direct edit to a log: the events, the generated index and the files only the
# tools write. It exits 2 with the tool to use on stderr, which Kiro sends to the agent. The
# protected paths come from each tool's configured log root. Run it as `sh <this file>`.
set -eu

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

FILE="$(node -e 'let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  try {
    const e = JSON.parse(s);
    const i = (e && e.tool_input) || {};
    const p = i.file_path || i.notebook_path || i.path || i.filePath || "";
    if (typeof p !== "string" || p === "") return;
    const path = require("path");
    const base = (e && typeof e.cwd === "string" && e.cwd) || process.cwd();
    const abs = path.resolve(base, p);
    const rel = path.relative(process.cwd(), abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
    process.stdout.write(rel.split(path.sep).join("/"));
  } catch (_) {}
});')"
[ -n "$FILE" ] || exit 0

case "$FILE" in
  'docs/adr/events/'*|'docs/adr/index.md'|'docs/adr/decisions/'*) TOOL=adr ;;
  'docs/issues/events/'*|'docs/issues/index.md') TOOL=issues ;;
  *) exit 0 ;;
esac

echo "$FILE is written only by the $TOOL tool, which validates and attributes every change. Use the $TOOL MCP tools or the $TOOL command instead of editing the file." >&2
exit 2
