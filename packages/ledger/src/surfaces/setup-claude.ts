import { stat } from "node:fs/promises";
import { join } from "node:path";
import { InvalidArgumentError } from "../errors.js";
import type { Git } from "../git/git.js";
import {
  arrayAt,
  type ConfiguredHook,
  expandPlaceholders,
  FIXTURE_SESSION,
  type HarnessRuntime,
  type HookKind,
  type HookResult,
  type HookScenario,
  objectAt,
  parseJsonObject,
  parseMcpServers,
  type RepoFiles,
  stringAt,
} from "./harness-runtime.js";
import type { SetupPiece } from "./setup.js";

/** A harness's name, for the `--harness <name>` opt-out and the piece ids. */
export type Harness = "claude" | "kiro";

/** Every harness init can write, in a stable order. */
export const HARNESSES: readonly Harness[] = ["claude", "kiro"];

/** The config directory whose presence marks a harness as in use. */
const HARNESS_DIR: Readonly<Record<Harness, string>> = { claude: ".claude", kiro: ".kiro" };

/**
 * The harnesses a repository uses, by the presence of their config directories (`.claude`,
 * `.kiro`). A repository with neither gets every harness, so a first `init` writes the full setup;
 * flags then opt pieces or harnesses out (never in, R1).
 */
export async function detectHarnesses(git: Git): Promise<readonly Harness[]> {
  const root = git.root ?? "";
  const present: Harness[] = [];
  for (const h of HARNESSES) {
    const there = await stat(join(root, HARNESS_DIR[h]))
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (there) present.push(h);
  }
  return present.length > 0 ? present : [...HARNESSES];
}

/** One MCP server entry: the key under `mcpServers` and the value (`command`/`args`/`env`/…). */
export interface McpServerEntry {
  readonly name: string;
  readonly value: unknown;
}

/**
 * An MCP stdio server value: `npx -y <package>@<version> mcp`, with `ARK_AGENT` naming the harness
 * and `ARK_ON_BEHALF_OF` passed through from the environment, never its value (R4). `version` MUST
 * be an exact published version; a range or `workspace:*` is refused.
 */
export function mcpStdioServer(o: {
  readonly pkg: string;
  readonly version: string;
  readonly agent: string;
  /** Kiro's config carries `disabled`/`autoApprove`; Claude's does not. */
  readonly kiroFields?: boolean;
}): unknown {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(o.version)) {
    throw new InvalidArgumentError(
      `MCP server version must be an exact published version, got ${JSON.stringify(o.version)}`,
    );
  }
  const base: Record<string, unknown> = {
    command: "npx",
    args: ["-y", `${o.pkg}@${o.version}`, "mcp"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell env placeholder, passed through verbatim (R4)
    env: { ARK_AGENT: o.agent, ARK_ON_BEHALF_OF: "${ARK_ON_BEHALF_OF}" },
  };
  return o.kiroFields === true ? { ...base, disabled: false, autoApprove: [] } : base;
}

/**
 * The exact file contents of the shared, ark-specific pieces a harness writes whole: the hook
 * scripts, the settings/hook JSON. These are identical whichever tool runs init, so init
 * reproduces the committed fixture byte-for-byte regardless of which tool wrote first (R9). Supply
 * `null` for a piece the harness does not have.
 */
export interface HarnessShared {
  /** `.claude/settings.json` (hooks + permissions.deny) or `.kiro` hook JSON files, as raw text. */
  readonly settings?: string;
  readonly sessionStartHook?: string;
  readonly beforeEditHook?: string;
  readonly sessionStartScript?: string;
  readonly beforeEditScript?: string;
}

/** The Claude harness's pieces (design: formats in one module per harness). */
export function claudePieces(o: {
  readonly server: McpServerEntry;
  readonly shared: HarnessShared;
}): SetupPiece[] {
  const pieces: SetupPiece[] = [
    {
      id: `claude.mcp.${o.server.name}`,
      file: ".mcp.json",
      ownership: {
        kind: "merge",
        scaffold: { mcpServers: {} },
        entries: { [`mcpServers.${o.server.name}`]: o.server.value },
      },
    },
  ];
  if (o.shared.settings !== undefined) {
    pieces.push({
      id: "claude.settings",
      file: ".claude/settings.json",
      ownership: { kind: "whole", text: o.shared.settings },
    });
  }
  if (o.shared.sessionStartScript !== undefined) {
    pieces.push({
      id: "claude.hook.session-start",
      file: ".claude/hooks/session-start.sh",
      ownership: { kind: "whole", text: o.shared.sessionStartScript },
    });
  }
  if (o.shared.beforeEditScript !== undefined) {
    pieces.push({
      id: "claude.hook.before-edit",
      file: ".claude/hooks/before-edit.sh",
      ownership: { kind: "whole", text: o.shared.beforeEditScript },
    });
  }
  return pieces;
}

/** The hook kind a configured command runs, by the script it names; `null` for someone else's. */
export function hookKindOf(command: string): HookKind | null {
  if (command.includes("session-start")) return "session-start";
  if (command.includes("before-edit")) return "before-edit";
  if (command.includes("protect-logs")) return "protect";
  return null;
}

/**
 * Whether Claude Code's `matcher` selects the tool `name`: `*`, empty or absent match all; letters,
 * digits, `_`, `-`, spaces, `,` and `|` list exact names; anything else is an unanchored regular
 * expression (code.claude.com/docs/en/hooks, "Matcher patterns").
 */
export function claudeMatcherMatches(matcher: string | null, name: string): boolean {
  if (matcher === null || matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher.split(/[|,]/).some((m) => m.trim() === name);
  }
  return new RegExp(matcher).test(name);
}

/** The file-editing tools Claude Code has: `Edit`, `Write` and `NotebookEdit` (tools-reference). */
const CLAUDE_EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

/** The `tool_input` field each Claude Code edit tool carries its target path in. */
const CLAUDE_PATH_FIELD: Readonly<Record<string, string>> = {
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

const CLAUDE_SESSION_SOURCES = ["startup", "resume", "clear", "compact", "fork"];
const CLAUDE_SETTINGS = ".claude/settings.json";

/** The hook handler fields Claude Code's command hooks document (hooks reference, "Command hook fields"). */
function claudeHooks(files: RepoFiles): readonly ConfiguredHook[] {
  const root = parseJsonObject(CLAUDE_SETTINGS, files.read(CLAUDE_SETTINGS));
  const events = objectAt(CLAUDE_SETTINGS, "hooks", root.hooks ?? {});
  const out: ConfiguredHook[] = [];
  for (const [trigger, groups] of Object.entries(events)) {
    arrayAt(CLAUDE_SETTINGS, `hooks.${trigger}`, groups).forEach((g, i) => {
      const where = `hooks.${trigger}[${i}]`;
      const group = objectAt(CLAUDE_SETTINGS, where, g);
      const matcher = group.matcher === undefined ? null : String(group.matcher);
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        throw new Error(`${CLAUDE_SETTINGS}: ${where}.matcher must be a string`);
      }
      arrayAt(CLAUDE_SETTINGS, `${where}.hooks`, group.hooks).forEach((h, j) => {
        const hw = `${where}.hooks[${j}]`;
        const handler = objectAt(CLAUDE_SETTINGS, hw, h);
        if (handler.type !== "command") {
          throw new Error(`${CLAUDE_SETTINGS}: ${hw}.type must be "command"`);
        }
        const command = stringAt(CLAUDE_SETTINGS, `${hw}.command`, handler.command);
        const timeout = handler.timeout;
        if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
          throw new Error(`${CLAUDE_SETTINGS}: ${hw}.timeout must be a positive number of seconds`);
        }
        const kind = hookKindOf(command);
        if (kind === null) return;
        out.push({
          kind,
          trigger,
          matcher,
          command,
          timeoutSeconds: typeof timeout === "number" ? timeout : null,
          file: CLAUDE_SETTINGS,
        });
      });
    });
  }
  return out;
}

/** The context a Claude Code hook may hand the agent is capped (hooks reference, "Output cap"). */
const CLAUDE_CONTEXT_CAP = 10_000;

/** How Claude Code runs what init writes (code.claude.com/docs/en/hooks, /permissions, /mcp). */
export const claudeRuntime: HarnessRuntime = {
  harness: "claude",
  shell: "bash",
  editTools: CLAUDE_EDIT_TOOLS,
  // SessionStart: plain stdout is context. PreToolUse: only JSON hookSpecificOutput reaches Claude.
  contextFormat: { "session-start": "plain", "before-edit": "json" },
  defaultTimeoutSeconds: () => 600,
  uncoveredEditTools: (hook) =>
    CLAUDE_EDIT_TOOLS.filter((t) => !claudeMatcherMatches(hook.matcher, t)),
  configuredHooks(files) {
    const hooks = claudeHooks(files);
    for (const h of hooks) {
      if (h.kind === "session-start") {
        if (h.trigger !== "SessionStart")
          throw new Error(`${h.file}: session-start must be a SessionStart hook`);
        const ok =
          h.matcher === null ||
          ["", "*"].includes(h.matcher) ||
          h.matcher.split(/[|,]/).every((m) => CLAUDE_SESSION_SOURCES.includes(m.trim()));
        if (!ok)
          throw new Error(
            `${h.file}: SessionStart matcher ${JSON.stringify(h.matcher)} is not one of ${CLAUDE_SESSION_SOURCES.join(", ")}`,
          );
      }
      if (h.kind === "before-edit" && h.trigger !== "PreToolUse") {
        throw new Error(`${h.file}: before-edit must be a PreToolUse hook`);
      }
    }
    return hooks;
  },
  invocation({ root, cwd, scenario }) {
    return { cwd, env: { CLAUDE_PROJECT_DIR: root }, stdin: claudeEvent(cwd, scenario) };
  },
  contextOf(kind, r) {
    if (r.status !== 0) throw new Error(`the hook exited ${r.status}: ${r.stderr.trim()}`);
    const out = r.stdout.trim();
    if (out === "") return null;
    if (kind === "session-start") {
      if (out.length > CLAUDE_CONTEXT_CAP)
        throw new Error("the hook's output is over 10,000 characters");
      return out;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(out);
    } catch {
      throw new Error(
        "a PreToolUse hook's plain stdout goes to Claude Code's debug log only; emit hookSpecificOutput JSON",
      );
    }
    const o = (doc as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    if (
      o === undefined ||
      o.hookEventName !== "PreToolUse" ||
      typeof o.additionalContext !== "string"
    ) {
      throw new Error(
        'expected {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "…"}}',
      );
    }
    if (o.additionalContext.length > CLAUDE_CONTEXT_CAP)
      throw new Error("additionalContext is over 10,000 characters");
    return o.additionalContext === "" ? null : o.additionalContext;
  },
  blocked(r: HookResult) {
    if (r.status === 2) return { blocked: true, message: r.stderr.trim() };
    try {
      const o = (JSON.parse(r.stdout) as { hookSpecificOutput?: Record<string, unknown> })
        .hookSpecificOutput;
      if (o?.permissionDecision === "deny") {
        return { blocked: true, message: String(o.permissionDecisionReason ?? "") };
      }
    } catch {
      // not JSON: not a decision
    }
    return { blocked: false, message: "" };
  },
  mcpFile: ".mcp.json",
  mcpServers: (files) => parseMcpServers(".mcp.json", files.read(".mcp.json")),
  mcpEnv(configured, user) {
    return Object.fromEntries(
      Object.entries(configured).map(([k, v]) => [k, expandPlaceholders(v, user)]),
    );
  },
  denyRules(files) {
    const root = parseJsonObject(CLAUDE_SETTINGS, files.read(CLAUDE_SETTINGS));
    const perms = objectAt(CLAUDE_SETTINGS, "permissions", root.permissions ?? {});
    const globs: string[] = [];
    arrayAt(CLAUDE_SETTINGS, "permissions.deny", perms.deny ?? []).forEach((rule, i) => {
      const m = /^([A-Za-z]+)\((.+)\)$/.exec(
        stringAt(CLAUDE_SETTINGS, `permissions.deny[${i}]`, rule),
      );
      if (m === null) return;
      const [, tool, glob] = m as unknown as [string, string, string];
      // Path rules are checked against Edit and Read only; the rest are accepted and never match.
      if (["Write", "NotebookEdit", "MultiEdit", "Glob", "Grep"].includes(tool)) {
        throw new Error(
          `${CLAUDE_SETTINGS}: ${tool}(${glob}) never matches; write Edit(${glob}), which covers Edit, Write and NotebookEdit`,
        );
      }
      if (tool !== "Edit") return;
      if (!/^(\/|~\/)/.test(glob)) {
        throw new Error(
          `${CLAUDE_SETTINGS}: Edit(${glob}) is relative to the session's directory; anchor it at the project with a leading /`,
        );
      }
      globs.push(glob);
    });
    return globs;
  },
};

/** A PreToolUse or SessionStart event as Claude Code sends it on stdin (hooks reference). */
function claudeEvent(cwd: string, scenario: HookScenario): string {
  const common = {
    session_id: FIXTURE_SESSION,
    transcript_path: `${cwd}/.claude/transcript.jsonl`,
    cwd,
    permission_mode: "default",
  };
  if (scenario.kind === "session-start") {
    return JSON.stringify({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "claude-opus-5",
    });
  }
  const field = CLAUDE_PATH_FIELD[scenario.tool];
  if (field === undefined) throw new Error(`${scenario.tool} is not a Claude Code edit tool`);
  const input =
    scenario.tool === "Write"
      ? { file_path: scenario.path, content: "x\n" }
      : scenario.tool === "NotebookEdit"
        ? { notebook_path: scenario.path, new_source: "x = 1", edit_mode: "replace", cell_id: "c1" }
        : { file_path: scenario.path, old_string: "a", new_string: "b", replace_all: false };
  return JSON.stringify({
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: scenario.tool,
    tool_input: input,
    tool_use_id: "toolu_fixture",
  });
}
