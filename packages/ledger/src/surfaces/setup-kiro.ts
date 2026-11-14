import {
  arrayAt,
  type ConfiguredHook,
  FIXTURE_SESSION,
  type HarnessRuntime,
  type HookScenario,
  objectAt,
  parseJsonObject,
  parseMcpServers,
  type RepoFiles,
  stringAt,
} from "./harness-runtime.js";
import type { SetupPiece } from "./setup.js";
import { type HarnessShared, hookKindOf, type McpServerEntry } from "./setup-claude.js";

/** The Kiro harness's pieces (design: formats in one module per harness). */
export function kiroPieces(o: {
  readonly server: McpServerEntry;
  readonly shared: HarnessShared;
}): SetupPiece[] {
  const pieces: SetupPiece[] = [
    {
      id: `kiro.mcp.${o.server.name}`,
      file: ".kiro/settings/mcp.json",
      ownership: {
        kind: "merge",
        scaffold: { mcpServers: {} },
        entries: { [`mcpServers.${o.server.name}`]: o.server.value },
      },
    },
  ];
  if (o.shared.sessionStartHook !== undefined) {
    pieces.push({
      id: "kiro.hook.session-start.def",
      file: ".kiro/hooks/session-start.kiro.hook.json",
      ownership: { kind: "whole", text: o.shared.sessionStartHook },
    });
  }
  if (o.shared.beforeEditHook !== undefined) {
    pieces.push({
      id: "kiro.hook.before-edit.def",
      file: ".kiro/hooks/before-edit.kiro.hook.json",
      ownership: { kind: "whole", text: o.shared.beforeEditHook },
    });
  }
  if (o.shared.sessionStartScript !== undefined) {
    pieces.push({
      id: "kiro.hook.session-start",
      file: ".kiro/hooks/session-start.sh",
      ownership: { kind: "whole", text: o.shared.sessionStartScript },
    });
  }
  if (o.shared.beforeEditScript !== undefined) {
    pieces.push({
      id: "kiro.hook.before-edit",
      file: ".kiro/hooks/before-edit.sh",
      ownership: { kind: "whole", text: o.shared.beforeEditScript },
    });
  }
  return pieces;
}

/** The triggers a standalone Kiro hook file may name (kiro.dev/docs/hooks/types/, PascalCase). */
const KIRO_TRIGGERS = [
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "PostFileCreate",
  "PostFileSave",
  "PostFileDelete",
  "PreTaskExec",
  "PostTaskExec",
  "Manual",
];

const KIRO_HOOKS_DIR = ".kiro/hooks";

/** The hook files in `.kiro/hooks`, parsed against the documented `version`/`hooks[]` shape. */
function kiroHooks(files: RepoFiles): readonly ConfiguredHook[] {
  const out: ConfiguredHook[] = [];
  for (const file of files.list(KIRO_HOOKS_DIR).filter((f) => f.endsWith(".json"))) {
    const root = parseJsonObject(file, files.read(file));
    if (root.version !== "v1") throw new Error(`${file}: version must be "v1"`);
    arrayAt(file, "hooks", root.hooks).forEach((h, i) => {
      const where = `hooks[${i}]`;
      const hook = objectAt(file, where, h);
      stringAt(file, `${where}.name`, hook.name);
      const trigger = stringAt(file, `${where}.trigger`, hook.trigger);
      if (!KIRO_TRIGGERS.includes(trigger)) {
        throw new Error(
          `${file}: ${where}.trigger ${JSON.stringify(trigger)} is not a documented trigger`,
        );
      }
      if (hook.matcher !== undefined && typeof hook.matcher !== "string") {
        throw new Error(`${file}: ${where}.matcher must be a string`);
      }
      const action = objectAt(file, `${where}.action`, hook.action);
      if (action.type !== "command")
        throw new Error(`${file}: ${where}.action.type must be "command"`);
      const command = stringAt(file, `${where}.action.command`, action.command);
      const timeout = hook.timeout;
      if (timeout !== undefined && (typeof timeout !== "number" || timeout < 0)) {
        throw new Error(`${file}: ${where}.timeout must be a number of seconds`);
      }
      const kind = hookKindOf(command);
      if (kind === null) return;
      out.push({
        kind,
        trigger,
        matcher: typeof hook.matcher === "string" ? hook.matcher : null,
        command,
        timeoutSeconds: typeof timeout === "number" ? timeout : null,
        file,
      });
    });
  }
  return out;
}

/** The tool names Kiro gives its `write` group: `fs_write` in CLI 2.x, the group name in V3. */
const KIRO_EDIT_TOOLS = ["fs_write", "write"] as const;

/**
 * How Kiro runs what init writes (kiro.dev/docs/hooks/, /hooks/actions/, /hooks/types/): a command
 * hook runs in the project root and gets the event as JSON on stdin; exit 0 adds stdout to the
 * agent's context, and any other exit code sends stderr to the agent and, for PreToolUse, blocks
 * the tool call.
 */
export const kiroRuntime: HarnessRuntime = {
  harness: "kiro",
  shell: "sh",
  editTools: KIRO_EDIT_TOOLS,
  contextFormat: { "session-start": "plain", "before-edit": "plain" },
  defaultTimeoutSeconds: () => 60,
  // The `write` group selects every built-in file write tool.
  uncoveredEditTools: (hook) => (hook.matcher === "write" ? [] : KIRO_EDIT_TOOLS),
  configuredHooks(files) {
    const hooks = kiroHooks(files);
    for (const h of hooks) {
      if (h.kind === "session-start" && h.trigger !== "SessionStart") {
        throw new Error(`${h.file}: session-start must be a SessionStart hook`);
      }
      if (h.kind !== "session-start") {
        if (h.trigger !== "PreToolUse")
          throw new Error(`${h.file}: ${h.kind} must be a PreToolUse hook`);
      }
    }
    return hooks;
  },
  invocation({ root, scenario }) {
    // Command hooks run in the project root, whatever directory the session was started from.
    return { cwd: root, env: {}, stdin: kiroEvent(root, scenario) };
  },
  contextOf(_kind, r) {
    if (r.status !== 0) throw new Error(`the hook exited ${r.status}: ${r.stderr.trim()}`);
    const out = r.stdout.trim();
    return out === "" ? null : out;
  },
  blocked: (r) => ({ blocked: r.status !== 0, message: r.stderr.trim() }),
  mcpFile: ".kiro/settings/mcp.json",
  mcpServers: (files) =>
    parseMcpServers(".kiro/settings/mcp.json", files.read(".kiro/settings/mcp.json"), (name, s) => {
      if (s.disabled !== undefined && typeof s.disabled !== "boolean") {
        throw new Error(`.kiro/settings/mcp.json: mcpServers.${name}.disabled must be a boolean`);
      }
      arrayAt(".kiro/settings/mcp.json", `mcpServers.${name}.autoApprove`, s.autoApprove ?? []);
    }),
  mcpEnv(configured, user) {
    // Kiro expands only variables the person approved under "Mcp Approved Env Vars"; an unapproved
    // or unset one arrives as the text `${NAME}`. Fixtures model an approved variable.
    return Object.fromEntries(
      Object.entries(configured).map(([k, v]) => [
        k,
        v.replace(
          /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (whole, name) => user[name as string] ?? whole,
        ),
      ]),
    );
  },
  denyRules: () => null,
};

/** A SessionStart or PreToolUse event as Kiro CLI V3 sends it on stdin (kiro.dev/docs/hooks/types/). */
function kiroEvent(root: string, scenario: HookScenario): string {
  const common = { cwd: root, session_id: FIXTURE_SESSION };
  if (scenario.kind === "session-start") {
    return JSON.stringify({ hook_event_name: "agentSpawn", ...common });
  }
  const input =
    scenario.tool === "fs_write"
      ? { command: "create", path: scenario.path, file_text: "x\n" }
      : { path: scenario.path, content: "x\n" };
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    ...common,
    tool_name: scenario.tool,
    tool_input: input,
  });
}
