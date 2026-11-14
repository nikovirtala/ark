import { shQuote } from "./harness-runtime.js";

/**
 * The hook scripts init writes for each harness, and the logic they share (?79, ?80, ?81). The
 * scripts stay thin: they `cd` to the repository, ask the tools, and hand the answer to one of the
 * small node programs below. All hook logic that isn't a call to a tool (reading the edited path
 * out of the event, shaping the output for the harness, resolving the main ref) lives in this one
 * module, so `<tool> hooks agent …` can take it over later (docs/03-setup-v1.md).
 *
 * The scripts use `node`, which `npx` already needs, so they add no dependency. The node programs
 * are single-quoted in the shell, so they use double quotes and no `$`.
 */

/** One tool's log, as the hooks protect and read it: the tool's name and its log root. */
export interface HookLog {
  readonly tool: string;
  /** The repo-relative log root, e.g. `docs/adr`. */
  readonly root: string;
  /** Repo-relative path patterns, below the root, that only the tool writes (besides `events/` and `index.md`). */
  readonly also?: readonly string[];
  /** The published package the tool runs from, e.g. `@nikovirtala/adr`. */
  readonly pkg: string;
  /** The exact version the setup pins. */
  readonly version: string;
}

/**
 * Reads the hook event from stdin and prints the repo-relative path of the file the tool is about to
 * edit, or nothing. The event's path field differs by harness and tool: `tool_input.file_path`
 * (Claude Code `Edit`, `Write`), `notebook_path` (`NotebookEdit`), and `path` or `file_path`
 * (Kiro's write tools). A relative path is resolved against the event's `cwd`, and a path outside the
 * repository (the process's directory) gives nothing.
 */
export const EXTRACT_EDITED_PATH_JS = [
  'let s = "";',
  'process.stdin.on("data", (d) => { s += d; });',
  'process.stdin.on("end", () => {',
  "  try {",
  "    const e = JSON.parse(s);",
  "    const i = (e && e.tool_input) || {};",
  '    const p = i.file_path || i.notebook_path || i.path || i.filePath || "";',
  '    if (typeof p !== "string" || p === "") return;',
  '    const path = require("path");',
  '    const base = (e && typeof e.cwd === "string" && e.cwd) || process.cwd();',
  "    const abs = path.resolve(base, p);",
  "    const rel = path.relative(process.cwd(), abs);",
  '    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;',
  '    process.stdout.write(rel.split(path.sep).join("/"));',
  "  } catch (_) {}",
  "});",
].join("\n");

/** How a harness takes a before-edit hook's context: plain stdout, or Claude Code's JSON. */
export type ContextFormat = "plain" | "claude-json";

/**
 * Reads the output of `<tool> for <path>` from stdin, drops the blocks that say no record applies
 * (`  no decisions`, `  no issues`), and prints what is left in the harness's format, or nothing.
 * Claude Code only delivers a PreToolUse hook's context as
 * `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": …}}` and caps it at
 * 10,000 characters (code.claude.com/docs/en/hooks).
 */
export function emitContextJs(format: ContextFormat): string {
  const out =
    format === "claude-json"
      ? 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text.slice(0, 9500) } }));'
      : "process.stdout.write(text);";
  return [
    'let s = "";',
    'process.stdin.on("data", (d) => { s += d; });',
    'process.stdin.on("end", () => {',
    "  const blocks = [];",
    "  let cur = null;",
    '  for (const l of s.split("\\n")) {',
    '    if (l.trim() === "") continue;',
    "    if (!/^\\s/.test(l)) { cur = [l]; blocks.push(cur); } else if (cur) cur.push(l);",
    "  }",
    "  const keep = blocks.filter((b) => !(b.length === 2 && /^\\s+no (decisions|issues)\\s*$/.test(b[1])));",
    '  const text = keep.map((b) => b.join("\\n")).join("\\n\\n");',
    `  if (text !== "") ${out}`,
    "});",
  ].join("\n");
}

/**
 * Shell that sets `SINCE` to the main ref the way numbering resolves it (`resolveMainRef`): a
 * `main_branch` set in a tool's config when it resolves, else `origin/HEAD`'s target, `origin/main`,
 * `origin/master`, `main`, `master`. `SINCE` is empty when none resolves.
 */
function mainRefShell(logs: readonly HookLog[]): string {
  const configs = logs.flatMap((l) => [`${l.root}/${l.tool}.toml`, `${l.tool}.toml`]);
  return `main_ref() {
  for f in ${configs.map(shQuote).join(" ")}; do
    [ -f "$f" ] || continue
    b="$(sed -n 's/^[[:space:]]*main_branch[[:space:]]*=[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$f" | head -n 1)"
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
SINCE="$(main_ref)"`;
}

/** `npm exec` over every tool's pinned package, so one download and start serves all the calls. */
function npmExec(logs: readonly HookLog[]): string {
  const packages = logs.map((l) => `--package=${l.pkg}@${l.version}`).join(" ");
  return `npm exec --yes ${packages} --`;
}

/** The tool commands' shared comment: why the scripts call the CLI and not `hooks agent …`. */
function pinsComment(logs: readonly HookLog[]): string {
  const pins = logs.map((l) => `${l.tool} ${l.version}`).join(" / ");
  return `# The design wants this logic inside the tools as \`<tool> hooks agent …\`. That subcommand does not
# exist in the pinned published versions (${pins}), so this calls the commands they do have.`;
}

/**
 * The session-start script: installs this clone's missing git hooks, then lists what changed since
 * the main ref and what is ready. One `npm exec` over every pinned package, so a cold cache pays one
 * download and one start. Plain stdout is the context in both harnesses.
 */
export function sessionStartScript(o: {
  readonly logs: readonly HookLog[];
  readonly harness: string;
  readonly refs: string;
}): string {
  const tools = o.logs.map((l) => l.tool);
  const inner = [
    ...tools.map((t) => `${t} hooks install >/dev/null 2>&1 || true`),
    'if [ -n "$1" ]; then',
    ...tools.map((t) => `  ${t} list --since "$1" 2>/dev/null || true`),
    "fi",
    ...(tools.includes("issues") ? ["issues ready 2>/dev/null || true"] : []),
  ].join("\n");
  return `#!/usr/bin/env sh
# ${o.harness} session-start hook (${o.refs}).
#
${pinsComment(o.logs)}
# \`hooks install\` installs any missing git hooks in this clone (the \`doctor --fix-clone\`
# part), then each tool lists what changed since the main ref, and \`issues ready\` lists pickable
# work. One \`npm exec\` serves every call, so a cold cache downloads once. Keep the pins in step
# with the MCP configs. Run it as \`sh <this file>\`: it needs no execute bit.
set -eu

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

${mainRefShell(o.logs)}

${npmExec(o.logs)} sh -c '
${inner}
' sh "$SINCE"
`;
}

/**
 * The before-edit script: reads the edited path from the event, asks every tool which records
 * govern it, and prints them in the harness's format, or nothing when none applies.
 */
export function beforeEditScript(o: {
  readonly logs: readonly HookLog[];
  readonly harness: string;
  readonly refs: string;
  readonly format: ContextFormat;
}): string {
  const tools = o.logs.map((l) => l.tool);
  const inner = tools.map((t) => `${t} for "$1" 2>/dev/null || true`).join("\n");
  const delivery =
    o.format === "claude-json"
      ? "Claude Code delivers a PreToolUse hook's context only as hookSpecificOutput JSON; plain stdout\n# goes to its debug log."
      : "Kiro adds a hook's stdout to the agent's context when the hook exits 0.";
  return `#!/usr/bin/env sh
# ${o.harness} before-edit hook (${o.refs}).
#
${pinsComment(o.logs)}
# \`<tool> for <path>\` reports the decisions and open issues that govern the file about to be
# edited. The event arrives as JSON on stdin; the path is read out of it and made relative to the
# repository. ${delivery}
# Prints nothing when no record applies. Run it as \`sh <this file>\`.
set -eu

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

FILE="$(node -e '${EXTRACT_EDITED_PATH_JS}')"

# Nothing to look up without a path inside the repository; let the edit proceed.
[ -n "$FILE" ] || exit 0

OUT="$(${npmExec(o.logs)} sh -c '
${inner}
' sh "$FILE" 2>/dev/null || true)"

[ -n "$OUT" ] || exit 0
printf '%s\\n' "$OUT" | node -e '${emitContextJs(o.format)}'
`;
}

/** The path patterns the tool alone writes, below its log root, as `case` patterns. */
export function protectedPatterns(log: HookLog): readonly string[] {
  return [
    `${log.root}/events/`,
    `${log.root}/index.md`,
    ...(log.also ?? []).map((p) => `${log.root}/${p}`),
  ];
}

/**
 * The protect script (Kiro): blocks a write to a log path the tools own, with a message naming the
 * tool, by exiting 2 with the message on stderr (kiro.dev/docs/hooks/actions: a PreToolUse hook that
 * exits non-zero blocks the call and sends stderr to the agent). The paths come from each tool's
 * configured log root.
 */
export function protectLogsScript(o: {
  readonly logs: readonly HookLog[];
  readonly harness: string;
  readonly refs: string;
}): string {
  const cases = o.logs
    .map((l) => {
      const pats = protectedPatterns(l).map((p) =>
        p.endsWith("/") ? `${shQuote(p)}*` : shQuote(p),
      );
      return `  ${pats.join("|")}) TOOL=${l.tool} ;;`;
    })
    .join("\n");
  return `#!/usr/bin/env sh
# ${o.harness} protect-logs hook (${o.refs}).
#
# Kiro keeps permission rules per person, outside the repository, so a committed PreToolUse hook
# is what refuses a direct edit to a log: the events, the generated index and the files only the
# tools write. It exits 2 with the tool to use on stderr, which Kiro sends to the agent. The
# protected paths come from each tool's configured log root. Run it as \`sh <this file>\`.
set -eu

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

FILE="$(node -e '${EXTRACT_EDITED_PATH_JS}')"
[ -n "$FILE" ] || exit 0

case "$FILE" in
${cases}
  *) exit 0 ;;
esac

echo "$FILE is written only by the $TOOL tool, which validates and attributes every change. Use the $TOOL MCP tools or the $TOOL command instead of editing the file." >&2
exit 2
`;
}
