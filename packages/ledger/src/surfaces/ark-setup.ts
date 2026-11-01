import { stringifyJson } from "./setup.js";
import type { Harness, HarnessShared, McpServerEntry } from "./setup-claude.js";
import { mcpStdioServer } from "./setup-claude.js";
import type { ToolSetup } from "./tool-init.js";

/**
 * ark's own agent-setup content, the single source of truth for R9 ("running `init` on ark
 * reproduces ark's committed setup with no diff"). It is ark-specific: the `ARK_AGENT` value per
 * harness, the deny globs, and the stand-in hook scripts the pinned CLIs need because they lack
 * the `hooks agent …` subcommands and `doctor` the design wants (see docs/03-setup-v1.md "What the
 * hand setup settled"). Both the adr and the issues CLI build their setup from here, so whichever
 * runs init first writes byte-identical shared pieces and the rerun owns them.
 *
 * The pins are the exact published versions. They are passed in so a release can bump them in one
 * place (?61) without editing the scripts by hand.
 */
export interface ArkPins {
  readonly adr: string;
  readonly issues: string;
}

/**
 * ark's current pins: the exact published versions ark runs its own agent tooling at (findings.md
 * §2; `adr:jgdhvxtq`). A release bumps these in one place (?61). They are the versions the setup
 * writes, so R9 holds against the committed fixture regardless of the workspace build's version.
 */
export const ARK_PINS: ArkPins = { adr: "0.5.10", issues: "0.5.6" };

/** The `ARK_AGENT` value each harness's MCP config carries. */
const AGENT: Readonly<Record<Harness, string>> = { claude: "claude-code", kiro: "kiro" };

/** The deny globs ark's Claude permission rules refuse direct edits to (design "Permission rules"). */
const DENY_GLOBS: readonly string[] = [
  "docs/*/events/**",
  "docs/*/index.md",
  "docs/adr/decisions/**",
];

/** ark's `.claude/settings.json`: the two harness hooks and the permission deny rules. */
function claudeSettings(): string {
  const value = {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.sh',
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/before-edit.sh',
            },
          ],
        },
      ],
    },
    permissions: {
      deny: DENY_GLOBS.flatMap((g) => [`Edit(${g})`, `Write(${g})`]),
    },
  };
  return stringifyJson(value);
}

/** A Kiro standalone hook definition file. */
function kiroHook(o: {
  readonly name: string;
  readonly description: string;
  readonly trigger: string;
  readonly matcher?: string;
  readonly command: string;
}): string {
  const hook: Record<string, unknown> = {
    name: o.name,
    description: o.description,
    trigger: o.trigger,
    ...(o.matcher === undefined ? {} : { matcher: o.matcher }),
    action: { type: "command", command: o.command },
  };
  return stringifyJson({ version: "v1", hooks: [hook] });
}

const claudeSessionStartScript = (p: ArkPins): string => `#!/usr/bin/env sh
# Session-start hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as \`<tool> hooks agent session-start\`,
# and the first step to be \`doctor --fix-clone\`. Neither the \`hooks agent\` subcommand
# nor \`doctor\` exists in the pinned published versions (adr ${p.adr} / issues ${p.issues});
# doctor arrives in a later slice. Until then this script runs the equivalent commands
# the pinned CLIs do expose: \`hooks install\` installs any missing git hooks in this
# clone (the \`--fix-clone\` part), then each tool lists what changed since the last
# session and \`issues ready\` lists pickable work. Keep the pins in step with .mcp.json.
set -eu

ADR="npx -y @nikovirtala/adr@${p.adr}"
ISSUES="npx -y @nikovirtala/issues@${p.issues}"

# Install git hooks if this clone is missing them (stand-in for \`doctor --fix-clone\`).
$ADR hooks install >/dev/null 2>&1 || true
$ISSUES hooks install >/dev/null 2>&1 || true

# What changed since the last session, and what is ready to pick up.
# --since takes a git rev; the previous main tip is a reasonable "last seen".
SINCE="$(git rev-parse --quiet --verify 'origin/main' 2>/dev/null || echo 'HEAD~1')"
$ADR list --since "$SINCE" 2>/dev/null || true
$ISSUES list --since "$SINCE" 2>/dev/null || true
$ISSUES ready 2>/dev/null || true
`;

const claudeBeforeEditScript = (p: ArkPins): string => `#!/usr/bin/env sh
# Before-edit hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as \`<tool> hooks agent before-edit\`.
# That subcommand does not exist in the pinned published versions (adr ${p.adr} /
# issues ${p.issues}), so this script calls the existing \`adr for <path>\` and
# \`issues for <path>\` commands, which report the decisions and open issues that
# govern the file about to be edited. Keep the pins in step with .mcp.json.
#
# The harness passes the tool-call event as JSON on stdin; pull the edited path from
# it. Claude Code uses tool_input.file_path; fall back to any "*path" string.
set -eu

ADR="npx -y @nikovirtala/adr@${p.adr}"
ISSUES="npx -y @nikovirtala/issues@${p.issues}"

EVENT="$(cat 2>/dev/null || true)"
PATH_EDITED="$(printf '%s' "$EVENT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"

# Nothing to look up without a path; let the edit proceed.
[ -n "$PATH_EDITED" ] || exit 0

$ADR for "$PATH_EDITED" 2>/dev/null || true
$ISSUES for "$PATH_EDITED" 2>/dev/null || true
`;

const kiroSessionStartScript = (p: ArkPins): string => `#!/usr/bin/env sh
# Kiro session-start hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as \`<tool> hooks agent session-start\`,
# with \`doctor --fix-clone\` first. Neither exists in the pinned published versions
# (adr ${p.adr} / issues ${p.issues}); doctor arrives in a later slice. Until then this runs
# the equivalent commands the pinned CLIs expose: \`hooks install\` installs any missing
# git hooks in this clone (the \`--fix-clone\` part), then each tool lists what changed
# since the last session and \`issues ready\` lists pickable work. The Claude copy of
# this script is .claude/hooks/session-start.sh; keep the two in step.
set -eu

ADR="npx -y @nikovirtala/adr@${p.adr}"
ISSUES="npx -y @nikovirtala/issues@${p.issues}"

$ADR hooks install >/dev/null 2>&1 || true
$ISSUES hooks install >/dev/null 2>&1 || true

SINCE="$(git rev-parse --quiet --verify 'origin/main' 2>/dev/null || echo 'HEAD~1')"
$ADR list --since "$SINCE" 2>/dev/null || true
$ISSUES list --since "$SINCE" 2>/dev/null || true
$ISSUES ready 2>/dev/null || true
`;

const kiroBeforeEditScript = (p: ArkPins): string => `#!/usr/bin/env sh
# Kiro before-edit hook (ADR-0017; docs/03-setup-v1.md "What a complete setup is").
#
# The design wants this logic inside the tools as \`<tool> hooks agent before-edit\`.
# That subcommand does not exist in the pinned published versions (adr ${p.adr} /
# issues ${p.issues}), so this calls \`adr for <path>\` and \`issues for <path>\`, which report
# the decisions and open issues that govern the file about to be edited. The Claude
# copy of this script is .claude/hooks/before-edit.sh; keep the two in step.
#
# Kiro passes the tool-call event as JSON on stdin; its V3 write tools carry the target
# path in tool input as "path" (and some as "file_path"). Pull whichever is present.
set -eu

ADR="npx -y @nikovirtala/adr@${p.adr}"
ISSUES="npx -y @nikovirtala/issues@${p.issues}"

EVENT="$(cat 2>/dev/null || true)"
PATH_EDITED="$(printf '%s' "$EVENT" | sed -n 's/.*"\\(file_path\\|path\\)"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\2/p' | head -n 1)"

[ -n "$PATH_EDITED" ] || exit 0

$ADR for "$PATH_EDITED" 2>/dev/null || true
$ISSUES for "$PATH_EDITED" 2>/dev/null || true
`;

/** ark's `package.json` `prepare` script: install both tools' git hooks (no `--quiet`; the pinned CLIs lack it). */
export function arkPrepare(p: ArkPins): string {
  return `npx -y @nikovirtala/adr@${p.adr} hooks install && npx -y @nikovirtala/issues@${p.issues} hooks install`;
}

/** The shared, ark-specific file contents per harness (identical whichever tool writes them). */
export function arkShared(p: ArkPins): Record<Harness, HarnessShared> {
  return {
    claude: {
      settings: claudeSettings(),
      sessionStartScript: claudeSessionStartScript(p),
      beforeEditScript: claudeBeforeEditScript(p),
    },
    kiro: {
      sessionStartHook: kiroHook({
        name: "ark session start",
        description:
          "Install git hooks, list decisions and issues changed since last session, and list ready issues.",
        trigger: "SessionStart",
        command: ".kiro/hooks/session-start.sh",
      }),
      beforeEditHook: kiroHook({
        name: "ark before edit",
        description: "Before an edit, report the decisions and open issues that govern the file.",
        trigger: "PreToolUse",
        matcher: "write",
        command: ".kiro/hooks/before-edit.sh",
      }),
      sessionStartScript: kiroSessionStartScript(p),
      beforeEditScript: kiroBeforeEditScript(p),
    },
  };
}

/** This tool's MCP server entry per harness, keyed by the server name. */
export function arkServers(o: {
  readonly pkg: string;
  readonly name: string;
  readonly version: string;
}): Record<Harness, McpServerEntry> {
  return {
    claude: {
      name: o.name,
      value: mcpStdioServer({ pkg: o.pkg, version: o.version, agent: AGENT.claude }),
    },
    kiro: {
      name: o.name,
      value: mcpStdioServer({
        pkg: o.pkg,
        version: o.version,
        agent: AGENT.kiro,
        kiroFields: true,
      }),
    },
  };
}

/**
 * ark's {@link ToolSetup} for one tool: its own MCP server entry per harness, the shared pieces,
 * and the `prepare` script. The pins must be exact published versions, never `workspace:*` (R8).
 */
export function arkSetup(o: {
  readonly harnesses: readonly Harness[];
  readonly pkg: string;
  readonly name: string;
  readonly version: string;
  readonly pins: ArkPins;
  readonly skip?: ReadonlySet<string>;
  readonly force?: ReadonlySet<string>;
}): ToolSetup {
  return {
    harnesses: o.harnesses,
    servers: arkServers({ pkg: o.pkg, name: o.name, version: o.version }),
    shared: arkShared(o.pins),
    prepare: arkPrepare(o.pins),
    ...(o.skip === undefined ? {} : { skip: o.skip }),
    ...(o.force === undefined ? {} : { force: o.force }),
  };
}
