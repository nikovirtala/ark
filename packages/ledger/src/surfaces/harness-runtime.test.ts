import { describe, expect, it } from "vitest";
import { expandPlaceholders, globMatches, type RepoFiles, shQuote } from "./harness-runtime.js";
import { claudeMatcherMatches, claudeRuntime, hookKindOf } from "./setup-claude.js";
import { kiroRuntime } from "./setup-kiro.js";

/** A repository of in-memory files. */
const files = (all: Record<string, string>): RepoFiles => ({
  read: (p) => all[p] ?? null,
  list: (dir) =>
    Object.keys(all).filter(
      (p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"),
    ),
});

const settings = (o: unknown) => files({ ".claude/settings.json": JSON.stringify(o) });
const hook = (command: string, extra: object = {}) => ({ type: "command", command, ...extra });

describe("the placeholder expansion Claude Code documents for .mcp.json", () => {
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the placeholders under test
  it.each([
    ["${A}", { A: "x" }, "x"],
    ["${A}", { A: "" }, ""],
    ["${A}", {}, "${A}"],
    ["${A:-}", {}, ""],
    ["${A:-d}", {}, "d"],
    ["${A:-d}", { A: "x" }, "x"],
    ["${A:-d}", { A: "" }, ""],
    ["p-${A}-${B:-b}", { A: "1" }, "p-1-b"],
    ["no placeholder", {}, "no placeholder"],
  ])("%s with %j is %j", (value, user, want) => {
    expect(expandPlaceholders(value, user)).toBe(want);
  });

  it("leaves a Kiro placeholder as it is until the variable is approved and set", () => {
    const env = { ARK_ON_BEHALF_OF: "${ARK_ON_BEHALF_OF}", ARK_AGENT: "kiro" };
    expect(kiroRuntime.mcpEnv(env, {}).ARK_ON_BEHALF_OF).toBe("${ARK_ON_BEHALF_OF}");
    expect(kiroRuntime.mcpEnv(env, { ARK_ON_BEHALF_OF: "a@b.org" }).ARK_ON_BEHALF_OF).toBe(
      "a@b.org",
    );
    expect(kiroRuntime.mcpEnv(env, {}).ARK_AGENT).toBe("kiro");
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: the placeholders under test
});

describe("globMatches: gitignore-style rules anchored at the project", () => {
  it.each([
    ["/docs/adr/events/**", "docs/adr/events/x/y.yaml", true],
    ["/docs/adr/events/**", "docs/adr/index.md", false],
    ["/docs/adr/index.md", "docs/adr/index.md", true],
    ["/docs/adr/index.md", "sub/docs/adr/index.md", false],
    ["/docs/*/index.md", "docs/adr/index.md", true],
    ["/docs/*/index.md", "docs/a/b/index.md", false],
    ["/a.b/**", "axb/c", false],
  ])("%s on %s is %s", (glob, path, want) => {
    expect(globMatches(glob, path)).toBe(want);
  });

  it("quotes one shell word", () => {
    expect(shQuote("a b")).toBe("'a b'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("Claude Code's matcher rules (hooks reference, 'Matcher patterns')", () => {
  it.each([
    ["Edit|Write|NotebookEdit", "NotebookEdit", true],
    ["Edit|Write", "NotebookEdit", false],
    ["Edit, Write", "Write", true],
    ["*", "Anything", true],
    ["", "Anything", true],
    [null, "Anything", true],
    ["Edit.*", "NotebookEdit", true],
    ["^Edit$", "NotebookEdit", false],
    ["mcp__memory__.*", "mcp__memory__store", true],
  ])("%j matches %s: %s", (matcher, tool, want) => {
    expect(claudeMatcherMatches(matcher, tool)).toBe(want);
  });

  it("names a hook's kind by the script it runs", () => {
    expect(hookKindOf('sh "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.sh')).toBe(
      "session-start",
    );
    expect(hookKindOf("sh .kiro/hooks/before-edit.sh")).toBe("before-edit");
    expect(hookKindOf("sh .kiro/hooks/protect-logs.sh")).toBe("protect");
    expect(hookKindOf("prettier --write")).toBeNull();
  });
});

describe("claudeRuntime.configuredHooks: the documented settings shape", () => {
  const ok = {
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [hook("sh x/session-start.sh")] }],
      PreToolUse: [
        {
          matcher: "Edit|Write|NotebookEdit",
          hooks: [hook("sh x/before-edit.sh", { timeout: 30 })],
        },
      ],
    },
  };

  it("reads the hooks, their matchers and timeouts, and skips hooks that aren't init's", () => {
    const withOther = {
      hooks: { ...ok.hooks, PostToolUse: [{ matcher: "Edit", hooks: [hook("prettier --write")] }] },
    };
    const got = claudeRuntime.configuredHooks(settings(withOther));
    expect(got.map((h) => [h.kind, h.trigger, h.matcher, h.timeoutSeconds])).toEqual([
      ["session-start", "SessionStart", "*", null],
      ["before-edit", "PreToolUse", "Edit|Write|NotebookEdit", 30],
    ]);
  });

  it.each([
    [
      "a SessionStart matcher that isn't a source",
      { SessionStart: [{ matcher: "begin", hooks: [hook("sh x/session-start.sh")] }] },
      /is not one of startup/,
    ],
    [
      "a session-start hook on another event",
      { Stop: [{ hooks: [hook("sh x/session-start.sh")] }] },
      /must be a SessionStart hook/,
    ],
    [
      "a handler that isn't a command",
      { SessionStart: [{ hooks: [{ type: "prompt", prompt: "x" }] }] },
      /type must be "command"/,
    ],
    [
      "a zero timeout",
      { SessionStart: [{ hooks: [hook("sh x/session-start.sh", { timeout: 0 })] }] },
      /positive number/,
    ],
    [
      "a group without hooks",
      { SessionStart: [{ matcher: "*" }] },
      /SessionStart\[0\]\.hooks must be an array/,
    ],
  ])("refuses %s", (_name, hooks, message) => {
    expect(() => claudeRuntime.configuredHooks(settings({ hooks }))).toThrow(message);
  });

  it("refuses a settings file that isn't JSON or is missing", () => {
    expect(() => claudeRuntime.configuredHooks(files({ ".claude/settings.json": "{" }))).toThrow(
      /not valid JSON/,
    );
    expect(() => claudeRuntime.configuredHooks(files({}))).toThrow(/missing/);
  });
});

describe("uncoveredEditTools: the edit tools a before-edit matcher misses", () => {
  const configured = (matcher: string | null) => ({
    kind: "before-edit" as const,
    trigger: "PreToolUse",
    matcher,
    command: "sh x/before-edit.sh",
    timeoutSeconds: null,
    file: "f",
  });

  it("names every Claude Code edit tool the matcher leaves out", () => {
    expect(claudeRuntime.uncoveredEditTools(configured("Edit|Write|NotebookEdit"))).toEqual([]);
    expect(claudeRuntime.uncoveredEditTools(configured("*"))).toEqual([]);
    expect(claudeRuntime.uncoveredEditTools(configured("Edit|Write"))).toEqual(["NotebookEdit"]);
    expect(claudeRuntime.uncoveredEditTools(configured("Bash"))).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
    ]);
  });

  it("is covered for Kiro by the write group, and not by another group", () => {
    expect(kiroRuntime.uncoveredEditTools(configured("write"))).toEqual([]);
    expect(kiroRuntime.uncoveredEditTools(configured("fs_read"))).toEqual(["fs_write", "write"]);
    expect(kiroRuntime.uncoveredEditTools(configured(null))).toEqual(["fs_write", "write"]);
  });
});

describe("claudeRuntime.denyRules: only anchored Edit rules count", () => {
  const deny = (...rules: string[]) =>
    claudeRuntime.denyRules(settings({ permissions: { deny: rules } }));

  it("returns the globs of the Edit rules", () => {
    expect(deny("Edit(/docs/a/**)", "Bash(rm *)", "Read(~/.ssh/*)")).toEqual(["/docs/a/**"]);
  });

  it.each([
    ["Write(/docs/a/**)", /Write\(\/docs\/a\/\*\*\) never matches; write Edit/],
    ["NotebookEdit(/docs/a/**)", /never matches/],
    ["Edit(docs/a/**)", /relative to the session's directory/],
    ["Edit(./docs/a/**)", /relative to the session's directory/],
  ])("refuses %s", (rule, message) => {
    expect(() => deny(rule)).toThrow(message);
  });

  it("accepts a bare Write or Edit rule for the whole tool", () => {
    expect(deny("Write", "Edit")).toEqual([]);
  });
});

describe("claudeRuntime output formats", () => {
  const run = (stdout: string, status = 0, stderr = "") => ({ status, stdout, stderr });
  const json = (o: unknown) => JSON.stringify(o);
  const good = json({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "ADR-1" },
  });

  it("takes a PreToolUse hook's context only from hookSpecificOutput.additionalContext", () => {
    expect(claudeRuntime.contextOf("before-edit", run(good))).toBe("ADR-1");
    expect(claudeRuntime.contextOf("before-edit", run(""))).toBeNull();
    expect(() => claudeRuntime.contextOf("before-edit", run("ADR-1 applies"))).toThrow(/debug log/);
    expect(() =>
      claudeRuntime.contextOf("before-edit", run(json({ additionalContext: "x" }))),
    ).toThrow(/hookSpecificOutput/);
    expect(() =>
      claudeRuntime.contextOf(
        "before-edit",
        run(json({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } })),
      ),
    ).toThrow(/hookSpecificOutput/);
    expect(() => claudeRuntime.contextOf("before-edit", run(good, 1, "boom"))).toThrow(
      /exited 1: boom/,
    );
  });

  it("takes a SessionStart hook's plain stdout, capped at 10,000 characters", () => {
    expect(claudeRuntime.contextOf("session-start", run("hello\n"))).toBe("hello");
    expect(() => claudeRuntime.contextOf("session-start", run("x".repeat(10_001)))).toThrow(
      /10,000/,
    );
  });

  it("blocks on exit 2 or a deny decision", () => {
    expect(claudeRuntime.blocked(run("", 2, "no"))).toEqual({ blocked: true, message: "no" });
    const deny = json({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "why" },
    });
    expect(claudeRuntime.blocked(run(deny))).toEqual({ blocked: true, message: "why" });
    expect(claudeRuntime.blocked(run(good))).toEqual({ blocked: false, message: "" });
    expect(claudeRuntime.blocked(run("", 1, "warn"))).toEqual({ blocked: false, message: "" });
  });

  it("starts hooks in the session's directory with CLAUDE_PROJECT_DIR and the documented event", () => {
    const inv = claudeRuntime.invocation({
      root: "/r",
      cwd: "/r/sub",
      scenario: { kind: "edit", tool: "NotebookEdit", path: "/r/n.ipynb" },
    });
    expect(inv.cwd).toBe("/r/sub");
    expect(inv.env).toEqual({ CLAUDE_PROJECT_DIR: "/r" });
    expect(JSON.parse(inv.stdin)).toMatchObject({
      hook_event_name: "PreToolUse",
      cwd: "/r/sub",
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/r/n.ipynb" },
    });
    const start = JSON.parse(
      claudeRuntime.invocation({ root: "/r", cwd: "/r", scenario: { kind: "session-start" } })
        .stdin,
    );
    expect(start).toMatchObject({ hook_event_name: "SessionStart", source: "startup" });
  });
});

describe("kiroRuntime: .kiro/hooks/*.json and how Kiro runs a command hook", () => {
  const file = (o: unknown) => files({ ".kiro/hooks/a.kiro.hook.json": JSON.stringify(o) });
  const hookDef = (over: object = {}) => ({
    name: "n",
    trigger: "PreToolUse",
    matcher: "write",
    action: { type: "command", command: "sh .kiro/hooks/protect-logs.sh" },
    ...over,
  });

  it("reads the hooks of every json file in the directory", () => {
    const got = kiroRuntime.configuredHooks(
      files({
        ".kiro/hooks/a.json": JSON.stringify({ version: "v1", hooks: [hookDef({ timeout: 5 })] }),
        ".kiro/hooks/notes.md": "x",
      }),
    );
    expect(got).toEqual([
      {
        kind: "protect",
        trigger: "PreToolUse",
        matcher: "write",
        command: "sh .kiro/hooks/protect-logs.sh",
        timeoutSeconds: 5,
        file: ".kiro/hooks/a.json",
      },
    ]);
  });

  it.each([
    ["a version other than v1", { version: "v2", hooks: [] }, /version must be "v1"/],
    [
      "a hook without a name",
      { version: "v1", hooks: [hookDef({ name: "" })] },
      /name must be a non-empty string/,
    ],
    [
      "an undocumented trigger",
      { version: "v1", hooks: [hookDef({ trigger: "preToolUse " })] },
      /not a documented trigger/,
    ],
    [
      "a non-command action",
      { version: "v1", hooks: [hookDef({ action: { type: "agent", prompt: "x" } })] },
      /must be "command"/,
    ],
    [
      "a before-edit hook on SessionStart",
      {
        version: "v1",
        hooks: [
          hookDef({
            trigger: "SessionStart",
            action: { type: "command", command: "sh x/before-edit.sh" },
          }),
        ],
      },
      /must be a PreToolUse hook/,
    ],
    [
      "a negative timeout",
      { version: "v1", hooks: [hookDef({ timeout: -1 })] },
      /timeout must be a number/,
    ],
  ])("refuses %s", (_name, doc, message) => {
    expect(() => kiroRuntime.configuredHooks(file(doc))).toThrow(message);
  });

  it("delivers stdout on exit 0 and blocks on any other exit code, with stderr for the agent", () => {
    const ok = { status: 0, stdout: "ctx\n", stderr: "" };
    expect(kiroRuntime.contextOf("before-edit", ok)).toBe("ctx");
    expect(kiroRuntime.contextOf("before-edit", { ...ok, stdout: " " })).toBeNull();
    expect(() =>
      kiroRuntime.contextOf("before-edit", { status: 1, stdout: "", stderr: "e" }),
    ).toThrow(/exited 1/);
    expect(kiroRuntime.blocked({ status: 2, stdout: "", stderr: "use adr\n" })).toEqual({
      blocked: true,
      message: "use adr",
    });
    expect(kiroRuntime.blocked(ok)).toEqual({ blocked: false, message: "" });
  });

  it("starts hooks in the project root with the event on stdin, whatever directory the session is in", () => {
    const inv = kiroRuntime.invocation({
      root: "/r",
      cwd: "/r/sub",
      scenario: { kind: "edit", tool: "fs_write", path: "/r/a.ts" },
    });
    expect(inv.cwd).toBe("/r");
    expect(JSON.parse(inv.stdin)).toMatchObject({
      hook_event_name: "PreToolUse",
      cwd: "/r",
      tool_name: "fs_write",
      tool_input: { path: "/r/a.ts" },
    });
    expect(kiroRuntime.denyRules(files({}))).toBeNull();
  });

  it("parses the MCP config with Kiro's extra fields", () => {
    const cfg = (server: object) =>
      files({ ".kiro/settings/mcp.json": JSON.stringify({ mcpServers: { a: server } }) });
    expect(
      kiroRuntime.mcpServers(
        cfg({ command: "npx", args: ["-y", "p@1.0.0"], disabled: false, autoApprove: [] }),
      )[0],
    ).toMatchObject({ name: "a", command: "npx" });
    expect(() => kiroRuntime.mcpServers(cfg({ command: "npx", disabled: "no" }))).toThrow(
      /disabled must be a boolean/,
    );
    expect(() => kiroRuntime.mcpServers(cfg({ command: "npx", autoApprove: "all" }))).toThrow(
      /autoApprove must be an array/,
    );
    expect(() => kiroRuntime.mcpServers(cfg({ command: "npx", env: { A: 1 } }))).toThrow(
      /env\.A must be a string/,
    );
    expect(() => kiroRuntime.mcpServers(cfg({}))).toThrow(/command must be a non-empty string/);
  });
});
