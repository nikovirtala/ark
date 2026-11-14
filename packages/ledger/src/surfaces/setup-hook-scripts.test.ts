import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { worktreeReader } from "../git/tree.js";
import { createTempRepo } from "../testing/temp-repo.js";
import { ARK_PINS, arkDefaultLogs, arkLogs, claudeDenyRules } from "./ark-setup.js";
import { globMatches } from "./harness-runtime.js";
import { claudeRuntime } from "./setup-claude.js";
import {
  beforeEditScript,
  EXTRACT_EDITED_PATH_JS,
  emitContextJs,
  type HookLog,
  protectedPatterns,
  protectLogsScript,
  sessionStartScript,
} from "./setup-hook-scripts.js";
import { kiroRuntime } from "./setup-kiro.js";
import type { ToolLog } from "./tool-log.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ledger-hook-")));
  dirs.push(d);
  return d;
};

/** Runs a node program the scripts embed, the way `node -e '…'` does, with `input` on stdin. */
function node(js: string, input: string, cwd = process.cwd()): string {
  const r = spawnSync(process.execPath, ["-e", js], { input, cwd, encoding: "utf8" });
  expect(r.stderr).toBe("");
  return r.stdout;
}

describe("EXTRACT_EDITED_PATH_JS: the edited path out of each harness's event", () => {
  const root = tmp();
  const extract = (event: unknown) => node(EXTRACT_EDITED_PATH_JS, JSON.stringify(event), root);
  const abs = (p: string) => join(root, p);

  it.each([
    ["Claude Code Edit", { tool_name: "Edit", tool_input: { file_path: abs("src/a.ts") } }],
    ["Claude Code Write", { tool_name: "Write", tool_input: { file_path: abs("src/a.ts") } }],
    [
      "Claude Code NotebookEdit",
      { tool_name: "NotebookEdit", tool_input: { notebook_path: abs("src/a.ts") } },
    ],
    ["Kiro fs_write", { tool_name: "fs_write", tool_input: { path: abs("src/a.ts") } }],
    [
      "Kiro write with file_path",
      { tool_name: "write", tool_input: { file_path: abs("src/a.ts") } },
    ],
    ["a relative path, against the event's cwd", { cwd: root, tool_input: { path: "src/a.ts" } }],
    [
      "a relative path from a subdirectory",
      { cwd: join(root, "src"), tool_input: { path: "a.ts" } },
    ],
    ["a path with ..", { cwd: root, tool_input: { path: "docs/../src/a.ts" } }],
  ])("%s", (_name, event) => {
    expect(extract(event)).toBe("src/a.ts");
  });

  it.each([
    ["a path outside the repository", { tool_input: { file_path: "/etc/passwd" } }],
    ["a path above the repository", { cwd: root, tool_input: { path: "../x" } }],
    ["the repository itself", { tool_input: { file_path: root } }],
    ["an event without a path", { tool_input: { command: "ls" } }],
    ["an event without tool_input", { hook_event_name: "SessionStart" }],
    ["a path that isn't a string", { tool_input: { file_path: 3 } }],
  ])("prints nothing for %s", (_name, event) => {
    expect(extract(event)).toBe("");
  });

  it("prints nothing for input that isn't JSON", () => {
    expect(node(EXTRACT_EDITED_PATH_JS, "not json", root)).toBe("");
    expect(node(EXTRACT_EDITED_PATH_JS, "", root)).toBe("");
  });

  it("agrees with each harness runtime's own fixture events", () => {
    const edit = (rt: typeof claudeRuntime, tool: string) =>
      rt.invocation({
        root,
        cwd: root,
        scenario: { kind: "edit", tool, path: abs("src/a.ts") },
      }).stdin;
    for (const tool of claudeRuntime.editTools) {
      expect(node(EXTRACT_EDITED_PATH_JS, edit(claudeRuntime, tool), root)).toBe("src/a.ts");
    }
    for (const tool of kiroRuntime.editTools) {
      expect(node(EXTRACT_EDITED_PATH_JS, edit(kiroRuntime, tool), root)).toBe("src/a.ts");
    }
  });
});

describe("emitContextJs: the tools' answer, in the harness's format", () => {
  const both =
    "src/a.ts\n  ADR-0001 (aaaa1111)  accepted    Use the store  glob src/**\nsrc/a.ts\n  no issues\n";
  const none = "README.md\n  no decisions\nREADME.md\n  no issues\n";

  it("drops the blocks that say no record applies", () => {
    expect(node(emitContextJs("plain"), both)).toBe(
      "src/a.ts\n  ADR-0001 (aaaa1111)  accepted    Use the store  glob src/**",
    );
  });

  it("keeps both tools' records, separated by a blank line", () => {
    const text = "a\n  ADR-0001  accepted  X\na\n  ?3  open  Y\n";
    expect(node(emitContextJs("plain"), text)).toBe(
      "a\n  ADR-0001  accepted  X\n\na\n  ?3  open  Y",
    );
  });

  it("prints nothing when no record applies, in either format", () => {
    expect(node(emitContextJs("plain"), none)).toBe("");
    expect(node(emitContextJs("claude-json"), none)).toBe("");
    expect(node(emitContextJs("claude-json"), "")).toBe("");
  });

  it("wraps the records as Claude Code's PreToolUse additionalContext JSON", () => {
    const doc = JSON.parse(node(emitContextJs("claude-json"), both));
    expect(doc).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "src/a.ts\n  ADR-0001 (aaaa1111)  accepted    Use the store  glob src/**",
      },
    });
  });

  it("keeps Claude Code's context under its 10,000-character cap", () => {
    const big = `src/a.ts\n  ${"x".repeat(30_000)}\n`;
    const doc = JSON.parse(node(emitContextJs("claude-json"), big));
    expect(doc.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
  });
});

describe("the protected paths follow each tool's configured log root", () => {
  const log = (tool: string, root: string, also: string[] = []): HookLog => ({
    tool,
    root,
    also,
    pkg: `@nikovirtala/${tool}`,
    version: "1.0.0",
  });

  it("lists the events, the index and the tool-only paths below the root", () => {
    expect(protectedPatterns(log("adr", "decisions", ["bodies/"]))).toEqual([
      "decisions/events/",
      "decisions/index.md",
      "decisions/bodies/",
    ]);
  });

  it("anchors every Claude Code deny rule at the project, as an Edit rule", () => {
    const rules = claudeDenyRules([log("adr", "arch/log", ["decisions/"]), log("issues", "work")]);
    expect(rules).toEqual([
      "Edit(/arch/log/events/**)",
      "Edit(/arch/log/index.md)",
      "Edit(/arch/log/decisions/**)",
      "Edit(/work/events/**)",
      "Edit(/work/index.md)",
    ]);
    // No rule names a tool whose path rules never match, or is relative to the session's directory.
    expect(rules.every((r) => r.startsWith("Edit(/"))).toBe(true);
  });

  it("matches the rules against files at any depth and no other", () => {
    const globs = claudeDenyRules([log("adr", "arch/log", ["decisions/"])]).map((r) =>
      r.slice("Edit(".length, -1),
    );
    const hit = (p: string) => globs.some((g) => globMatches(g, p));
    expect(hit("arch/log/events/abc/20261114T000000Z-x-proposed.yaml")).toBe(true);
    expect(hit("arch/log/index.md")).toBe(true);
    expect(hit("arch/log/decisions/x.md")).toBe(true);
    expect(hit("docs/adr/events/x.yaml")).toBe(false);
    expect(hit("arch/log/templates/nygard.md")).toBe(false);
    expect(hit("src/arch/log/index.md")).toBe(false);
  });

  it("derives both tools' roots from the repository's configs, not a fixed docs/", async () => {
    const r = await createTempRepo({
      files: {
        "README.md": "x\n",
        // adr's log is elsewhere, named by a repo-level config; issues' is at its default root.
        "adr.toml": '[log]\nroot = "arch/decisions"\n',
        "docs/issues/issues.toml": "[log]\n",
      },
    });
    try {
      const adr = { tree: worktreeReader(r.git), layout: { root: "arch/decisions" } } as Pick<
        ToolLog,
        "layout" | "tree"
      >;
      const logs = await arkLogs(adr, "adr", ARK_PINS);
      expect(logs.map((l) => [l.tool, l.root])).toEqual([
        ["adr", "arch/decisions"],
        ["issues", "docs/issues"],
      ]);
      expect(claudeDenyRules(logs)).toContain("Edit(/arch/decisions/events/**)");
      expect(claudeDenyRules(logs)).not.toContain("Edit(/docs/adr/events/**)");
    } finally {
      await r.dispose();
    }
  });

  it("leaves a tool whose config isn't in the repository out", async () => {
    const r = await createTempRepo({ files: { "README.md": "x\n" } });
    try {
      const adr = { tree: worktreeReader(r.git), layout: { root: "docs/adr" } } as Pick<
        ToolLog,
        "layout" | "tree"
      >;
      expect((await arkLogs(adr, "adr", ARK_PINS)).map((l) => l.tool)).toEqual(["adr"]);
    } finally {
      await r.dispose();
    }
  });
});

describe("the protect script for a non-default log root", () => {
  const root = tmp();
  spawnSync("git", ["init", "-q"], { cwd: root });
  const logs: HookLog[] = [
    { tool: "adr", root: "arch/log", also: ["decisions/"], pkg: "@x/adr", version: "1.0.0" },
    { tool: "issues", root: "work", pkg: "@x/issues", version: "1.0.0" },
  ];
  const script = join(root, "protect.sh");
  writeFileSync(script, protectLogsScript({ logs, harness: "Kiro", refs: "test" }));
  const run = (path: string) =>
    spawnSync("sh", [script], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({ cwd: root, tool_name: "fs_write", tool_input: { path } }),
      env: { ...process.env, GIT_DIR: undefined, GIT_CEILING_DIRECTORIES: undefined },
    });

  it("is a script that parses", () => {
    expect(spawnSync("sh", ["-n", script]).status).toBe(0);
  });

  it.each([
    ["arch/log/events/abc/x.yaml", "adr"],
    ["arch/log/index.md", "adr"],
    ["arch/log/decisions/x.md", "adr"],
    ["work/events/k/y.yaml", "issues"],
    ["work/index.md", "issues"],
  ])("blocks %s and names the %s tool", (path, tool) => {
    const r = run(join(root, path));
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain(`the ${tool} tool`);
  });

  it.each([
    "docs/adr/events/x.yaml",
    "docs/adr/index.md",
    "arch/log/templates/nygard.md",
    "arch/logbook.md",
    "work/templates/task.md",
    "src/app.ts",
  ])("lets %s through: it is not a path the tools alone write", (path) => {
    const r = run(join(root, path));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("lets an edit outside the repository through", () => {
    expect(run("/etc/hosts").status).toBe(0);
  });
});

describe("script text", () => {
  const logs = arkDefaultLogs(ARK_PINS);

  it("starts every script with an sh shebang and assumes neither origin/main nor HEAD~1", () => {
    for (const text of [
      sessionStartScript({ logs, harness: "H", refs: "R" }),
      beforeEditScript({ logs, harness: "H", refs: "R", format: "plain" }),
      protectLogsScript({ logs, harness: "H", refs: "R" }),
    ]) {
      expect(text.startsWith("#!/usr/bin/env sh\n")).toBe(true);
      expect(text).not.toContain("origin/main'");
      expect(text).not.toContain("HEAD~1");
    }
  });
});
