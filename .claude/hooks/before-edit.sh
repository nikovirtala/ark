#!/usr/bin/env sh
# Claude Code before-edit hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as `<tool> hooks agent …`. That subcommand does not
# exist in the pinned published versions (adr 0.6.1 / issues 0.6.1), so this calls the commands they do have.
# `<tool> for <path>` reports the decisions and open issues that govern the file about to be
# edited. The event arrives as JSON on stdin; the path is read out of it and made relative to the
# repository. Claude Code delivers a PreToolUse hook's context only as hookSpecificOutput JSON; plain stdout
# goes to its debug log.
# Prints nothing when no record applies. Run it as `sh <this file>`.
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

# Nothing to look up without a path inside the repository; let the edit proceed.
[ -n "$FILE" ] || exit 0

OUT="$(npm exec --yes --package=@nikovirtala/adr@0.6.1 --package=@nikovirtala/issues@0.6.1 -- sh -c '
adr for "$1" 2>/dev/null || true
issues for "$1" 2>/dev/null || true
' sh "$FILE" 2>/dev/null || true)"

[ -n "$OUT" ] || exit 0
printf '%s\n' "$OUT" | node -e 'let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  const blocks = [];
  let cur = null;
  for (const l of s.split("\n")) {
    if (l.trim() === "") continue;
    if (!/^\s/.test(l)) { cur = [l]; blocks.push(cur); } else if (cur) cur.push(l);
  }
  const keep = blocks.filter((b) => !(b.length === 2 && /^\s+no (decisions|issues)\s*$/.test(b[1])));
  const text = keep.map((b) => b.join("\n")).join("\n\n");
  if (text !== "") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text.slice(0, 9500) } }));
});'
