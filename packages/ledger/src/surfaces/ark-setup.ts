import { normalizeLayout } from "../identity/layout.js";
import { readToolConfig } from "../sources/config.js";
import { stringifyJson } from "./setup.js";
import type { Harness, HarnessShared, McpServerEntry } from "./setup-claude.js";
import { mcpStdioServer } from "./setup-claude.js";
import {
  beforeEditScript,
  type HookLog,
  protectedPatterns,
  protectLogsScript,
  sessionStartScript,
} from "./setup-hook-scripts.js";
import type { ToolSetup } from "./tool-init.js";
import type { ToolLog } from "./tool-log.js";

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
export const ARK_PINS: ArkPins = { adr: "0.7.0", issues: "0.7.0" };

/** The `ARK_AGENT` value each harness's MCP config carries. */
const AGENT: Readonly<Record<Harness, string>> = { claude: "claude-code", kiro: "kiro" };

/** The tools ark's shared setup serves: their packages, default log roots and tool-only paths. */
const ARK_TOOLS = [
  {
    tool: "adr",
    pkg: "@nikovirtala/adr",
    defaultRoot: "docs/adr",
    // Decision bodies freeze when accepted, so they change only through the tool (ADR-0021).
    also: ["decisions/"],
  },
  { tool: "issues", pkg: "@nikovirtala/issues", defaultRoot: "docs/issues", also: [] },
] as const;

/**
 * The logs the shared hooks and deny rules cover: this tool's own log (at the root it opened), and
 * every sibling tool whose config is in the repository, at the root that config names (`[log] root`
 * in a repo-level `<tool>.toml`, else the default root with its config). Both tools derive the same
 * list, so whichever runs init first writes byte-identical shared pieces (R9), and the protected
 * paths follow each tool's configured root, never a fixed `docs/`.
 */
export async function arkLogs(
  log: Pick<ToolLog, "layout" | "tree">,
  tool: string,
  pins: ArkPins = ARK_PINS,
): Promise<readonly HookLog[]> {
  const logs: HookLog[] = [];
  for (const t of ARK_TOOLS) {
    let root: string | null = null;
    if (t.tool === tool) {
      root = log.layout.root;
    } else {
      const repo = await readToolConfig(log.tree, `${t.tool}.toml`);
      const named = (repo?.raw.log as { root?: unknown } | undefined)?.root;
      if (typeof named === "string") root = normalizeLayout({ root: named }).root;
      else if (repo !== null || (await log.tree.read(`${t.defaultRoot}/${t.tool}.toml`)) !== null) {
        root = t.defaultRoot;
      }
    }
    if (root !== null) {
      logs.push({
        tool: t.tool,
        root,
        also: t.also,
        pkg: t.pkg,
        version: t.tool === "adr" ? pins.adr : pins.issues,
      });
    }
  }
  return logs;
}

/** ark's default logs, for tests and callers without a repository: both tools at their default roots. */
export function arkDefaultLogs(pins: ArkPins = ARK_PINS): readonly HookLog[] {
  return ARK_TOOLS.map((t) => ({
    tool: t.tool,
    root: t.defaultRoot,
    also: t.also,
    pkg: t.pkg,
    version: t.tool === "adr" ? pins.adr : pins.issues,
  }));
}

/** The deny rule for each path a tool alone writes, anchored at the project with a leading `/`. */
export function claudeDenyRules(logs: readonly HookLog[]): string[] {
  return logs.flatMap(protectedPatterns).map((p) => `Edit(/${p.endsWith("/") ? `${p}**` : p})`);
}

/**
 * ark's `.claude/settings.json`: the two harness hooks and the permission deny rules. `Edit` rules
 * cover every file-editing tool (`Edit`, `Write`, `NotebookEdit`); `Write(path)` rules are accepted
 * and never match. A leading `/` anchors a path at the project, whatever directory the session
 * starts in (code.claude.com/docs/en/permissions).
 */
function claudeSettings(logs: readonly HookLog[]): string {
  const value = {
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: 'sh "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.sh',
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Edit|Write|NotebookEdit",
          hooks: [
            {
              type: "command",
              command: 'sh "$CLAUDE_PROJECT_DIR"/.claude/hooks/before-edit.sh',
            },
          ],
        },
      ],
    },
    permissions: { deny: claudeDenyRules(logs) },
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
  readonly timeout?: number;
}): string {
  const hook: Record<string, unknown> = {
    name: o.name,
    description: o.description,
    trigger: o.trigger,
    ...(o.matcher === undefined ? {} : { matcher: o.matcher }),
    action: { type: "command", command: o.command },
    ...(o.timeout === undefined ? {} : { timeout: o.timeout }),
  };
  return stringifyJson({ version: "v1", hooks: [hook] });
}

/** What the generated scripts cite: the decision and the design they come from. */
const REFS = 'ADR-0017; docs/03-setup-v1.md "What a complete setup is"';

/**
 * ark's `package.json` `prepare` script. The design's `<tool> hooks install --quiet` cannot `npx`
 * the pinned tools in ark itself: ark pins `@nikovirtala/adr` and `@nikovirtala/issues` as
 * `workspace:*`, so `npx @nikovirtala/<tool>@<version>` resolves to the unbuilt workspace copy and
 * crashes `pnpm install` on a fresh/CI checkout (and running the workspace build from ark's own
 * config would violate R8). So ark's setup writes its build-safe installer instead, which installs
 * the hooks when built and, with `--if-built`, skips with exit 0 on an unbuilt checkout. See
 * docs/03-setup-v1.md "What the hand setup settled". The arg is kept so the signature stays in step
 * with the other generators even though the value no longer depends on the pins.
 */
export function arkPrepare(_p: ArkPins): string {
  return "node scripts/git-hooks.mjs install --if-built";
}

/** The shared, ark-specific file contents per harness (identical whichever tool writes them). */
export function arkShared(logs: readonly HookLog[]): Record<Harness, HarnessShared> {
  const base = { logs, refs: REFS };
  return {
    claude: {
      settings: claudeSettings(logs),
      sessionStartScript: sessionStartScript({ ...base, harness: "Claude Code" }),
      beforeEditScript: beforeEditScript({
        ...base,
        harness: "Claude Code",
        format: "claude-json",
      }),
    },
    kiro: {
      sessionStartHook: kiroHook({
        name: "ark session start",
        description:
          "Install git hooks, list decisions and issues changed since last session, and list ready issues.",
        trigger: "SessionStart",
        command: "sh .kiro/hooks/session-start.sh",
        // A cold npm cache downloads both tools first (about 2 s here); the default is 60 s.
        timeout: 120,
      }),
      beforeEditHook: kiroHook({
        name: "ark before edit",
        description: "Before an edit, report the decisions and open issues that govern the file.",
        trigger: "PreToolUse",
        matcher: "write",
        command: "sh .kiro/hooks/before-edit.sh",
      }),
      protectHook: kiroHook({
        name: "ark protect logs",
        description:
          "Refuse a direct edit to the decision and issue logs; they change through the tools.",
        trigger: "PreToolUse",
        matcher: "write",
        command: "sh .kiro/hooks/protect-logs.sh",
      }),
      sessionStartScript: sessionStartScript({ ...base, harness: "Kiro" }),
      beforeEditScript: beforeEditScript({ ...base, harness: "Kiro", format: "plain" }),
      protectScript: protectLogsScript({ ...base, harness: "Kiro" }),
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
 * The `.gitattributes` lines for one tool's own log: its events marked `linguist-generated`, so
 * GitHub folds them in pull request diffs as it does generated code. The events are the tool's to
 * write and verify; a reviewer reads the change through `index.md` and the commit messages. Each
 * tool writes only its own log's line, so a repository that uses one tool gets one line.
 */
export function gitattributesLines(logs: readonly HookLog[], tool: string): string[] {
  return logs
    .filter((l) => l.tool === tool)
    .map((l) => `${l.root}/events/** linguist-generated=true`);
}

/**
 * ark's {@link ToolSetup} for one tool: its own MCP server entry per harness, the shared pieces,
 * the `prepare` script and its `.gitattributes` lines. The pins must be exact published versions, never `workspace:*` (R8).
 */
export function arkSetup(o: {
  readonly harnesses: readonly Harness[];
  readonly pkg: string;
  readonly name: string;
  readonly version: string;
  readonly pins: ArkPins;
  /** The logs the hooks and deny rules cover; see {@link arkLogs}. */
  readonly logs: readonly HookLog[];
  readonly skip?: ReadonlySet<string>;
  readonly force?: ReadonlySet<string>;
}): ToolSetup {
  return {
    harnesses: o.harnesses,
    servers: arkServers({ pkg: o.pkg, name: o.name, version: o.version }),
    shared: arkShared(o.logs),
    prepare: arkPrepare(o.pins),
    gitattributes: { tool: o.name, lines: gitattributesLines(o.logs, o.name) },
    ...(o.skip === undefined ? {} : { skip: o.skip }),
    ...(o.force === undefined ? {} : { force: o.force }),
  };
}
