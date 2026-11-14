import type { Harness } from "./setup-claude.js";

/**
 * How a harness runs what init writes (design "Which harnesses", ?81). Each harness module
 * (`setup-claude.ts`, `setup-kiro.ts`) declares one, so the tests that run the setup the way the
 * harness does iterate over the modules, and a new harness is one module plus its fixture events.
 * It records what the harness's documentation says; docs/03-setup-v1.md lists the pages and the
 * date each was checked.
 */

/** The three kinds of hook init writes. `protect` blocks edits to the logs (Kiro only, ?80). */
export type HookKind = "session-start" | "before-edit" | "protect";

/** One hook a harness config runs, as the harness reads it. */
export interface ConfiguredHook {
  readonly kind: HookKind;
  /** The harness's name for the event, as configured (`PreToolUse`, `SessionStart`, …). */
  readonly trigger: string;
  /** The matcher as configured; `null` when the config has none. */
  readonly matcher: string | null;
  /** The command string, run through the harness's shell. */
  readonly command: string;
  /** The configured timeout in seconds; `null` when the harness's default applies. */
  readonly timeoutSeconds: number | null;
  /** The repo-relative config file the hook comes from. */
  readonly file: string;
}

/** What a hook run is for: a session starting, or an edit by one of the harness's edit tools. */
export type HookScenario =
  | { readonly kind: "session-start" }
  | {
      readonly kind: "edit";
      /** The harness's name for the editing tool, e.g. `Edit`, `Write`, `NotebookEdit`, `write`. */
      readonly tool: string;
      /** The absolute path of the file the tool is about to edit. */
      readonly path: string;
    };

/** How the harness starts a hook: the working directory, extra environment and stdin event. */
export interface HookInvocation {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
}

/** The files of a repository a harness's config is read from. */
export interface RepoFiles {
  /** The text of the repo-relative `path`, or `null` when it is missing. */
  read(path: string): string | null;
  /** The repo-relative paths of the files directly in `dir` (none when it is missing). */
  list(dir: string): readonly string[];
}

/** What a finished hook process left behind. */
export interface HookResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** An MCP server as the harness's config declares it. */
export interface ConfiguredMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface HarnessRuntime {
  readonly harness: Harness;
  /** The shell the harness runs a hook command string through. */
  readonly shell: "bash" | "sh";
  /** The edit tools the before-edit hook must cover, by the harness's name for them. */
  readonly editTools: readonly string[];
  /** Whether the harness's hook output reaches the agent on `kind`, and in which format. */
  readonly contextFormat: Readonly<Record<"session-start" | "before-edit", "plain" | "json">>;
  /** The seconds a hook may run when its config sets no timeout. */
  defaultTimeoutSeconds(kind: HookKind): number;
  /**
   * The edit tools (by {@link editTools}) that `hook`'s matcher does not select: a before-edit or
   * protect hook that misses one never runs for it.
   */
  uncoveredEditTools(hook: ConfiguredHook): readonly string[];
  /** Parses the harness's hook config, throwing when it deviates from the documented shape. */
  configuredHooks(files: RepoFiles): readonly ConfiguredHook[];
  /** How the harness starts `hook` for `scenario` in a repository at `root`. */
  invocation(o: {
    readonly root: string;
    readonly cwd: string;
    readonly scenario: HookScenario;
  }): HookInvocation;
  /**
   * The context a finished hook hands the agent, or `null` for none. Throws when the output is in
   * a format the harness would not deliver (e.g. plain text from a Claude Code PreToolUse hook).
   */
  contextOf(kind: "session-start" | "before-edit", result: HookResult): string | null;
  /** Whether a finished hook blocked the tool call, and the message the agent gets. */
  blocked(result: HookResult): { readonly blocked: boolean; readonly message: string };
  /** The repo-relative file the harness reads MCP servers from. */
  readonly mcpFile: string;
  /** Parses the MCP config, throwing when it deviates from the documented shape. */
  mcpServers(files: RepoFiles): readonly ConfiguredMcpServer[];
  /** The env a server gets, given the person's environment: the harness's `${VAR}` expansion. */
  mcpEnv(
    configured: Readonly<Record<string, string>>,
    user: Readonly<Record<string, string | undefined>>,
  ): Record<string, string>;
  /**
   * The repo-relative paths whose edits the harness's rules refuse, as written in its config:
   * `null` when the harness has no committed rule file (Kiro blocks with a hook instead).
   */
  denyRules(files: RepoFiles): readonly string[] | null;
}

/** A fixed session id for fixture events. */
export const FIXTURE_SESSION = "00000000-aaaa-bbbb-cccc-000000000000";

/** Parses `text` as a JSON object, naming `file` in the error. */
export function parseJsonObject(file: string, text: string | null): Record<string, unknown> {
  if (text === null) throw new Error(`${file}: the file is missing`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${(err as Error).message})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** The value at `key` when it is an object, else a descriptive error. */
export function objectAt(file: string, where: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file}: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** The value when it is an array, else a descriptive error. */
export function arrayAt(file: string, where: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${file}: ${where} must be an array`);
  return value;
}

/** The value when it is a non-empty string, else a descriptive error. */
export function stringAt(file: string, where: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${file}: ${where} must be a non-empty string`);
  }
  return value;
}

/** Parses an MCP `mcpServers` object the way both harnesses document it (stdio servers). */
export function parseMcpServers(
  file: string,
  text: string | null,
  extra?: (name: string, server: Record<string, unknown>) => void,
): readonly ConfiguredMcpServer[] {
  const root = parseJsonObject(file, text);
  const servers = objectAt(file, "mcpServers", root.mcpServers);
  return Object.entries(servers).map(([name, raw]) => {
    const where = `mcpServers.${name}`;
    const s = objectAt(file, where, raw);
    const args = arrayAt(file, `${where}.args`, s.args ?? []).map((a, i) =>
      stringAt(file, `${where}.args[${i}]`, a),
    );
    const env = objectAt(file, `${where}.env`, s.env ?? {});
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== "string") throw new Error(`${file}: ${where}.env.${k} must be a string`);
      out[k] = v;
    }
    extra?.(name, s);
    return { name, command: stringAt(file, `${where}.command`, s.command), args, env: out };
  });
}

/**
 * Expands `${VAR}` and `${VAR:-default}` in `value` against `user`: a set variable (even empty)
 * gives its value, an unset one its default, or, without one, the text as it is. This is what
 * Claude Code documents for `.mcp.json` (code.claude.com/docs/en/mcp).
 */
export function expandPlaceholders(
  value: string,
  user: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, dflt) => {
    const v = user[name as string];
    if (v !== undefined) return v;
    return dflt === undefined ? whole : (dflt as string);
  });
}

/** `shQuote("a'b")` is `'a'\''b'`: one POSIX shell word. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether the repo-relative `path` matches the gitignore-style `glob` the permission rules use,
 * anchored at the project root: `*` stays inside a segment, `**` crosses segments.
 */
export function globMatches(glob: string, path: string): boolean {
  const re = glob
    .replace(/^\//, "")
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${re}$`).test(path);
}
