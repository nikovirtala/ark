import { statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installToolStubs,
  repoFiles,
  runHook,
  type ToolStubs,
} from "../testing/harness-conformance.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { parseOnBehalfOf } from "./actor.js";
import { ARK_PINS, arkDefaultLogs, arkSetup } from "./ark-setup.js";
import { globMatches, type HarnessRuntime } from "./harness-runtime.js";
import { HARNESS_RUNTIMES } from "./harness-runtimes.js";
import { applySetup, type SetupPiece } from "./setup.js";
import { HARNESSES, type Harness } from "./setup-claude.js";
import { setupPieces } from "./tool-init.js";

/**
 * The generated agent setup, run the way each harness runs it (?81). The tests that compared bytes
 * with ark's committed files (R9) passed while no hook ran, no hook output reached the agent, MCP
 * writes failed and the deny rules depended on the working directory. Here every configured hook
 * command string runs through the harness's own shell, from the directory and with the event the
 * harness documents, and the result is checked in the format the harness delivers. The suite
 * iterates over the harness modules (`HARNESS_RUNTIMES`), so a new harness adds a module and its
 * fixture events, not a test.
 *
 * Findings of the 2026-11-14 audit that a test covers are named in `KNOWN_FAILING` until the
 * change that fixes them lands; such a test is expected to fail (`it.fails`) and starts failing
 * the build when the fix makes it pass, so the entry has to go.
 */
const KNOWN_FAILING: ReadonlySet<string> = new Set<string>();

type Finding = "77" | "78" | "79" | "80" | "81";
/** `it`, or `it.fails` while the finding it checks is still open. */
const checks = (...findings: Finding[]) =>
  findings.some((f) => KNOWN_FAILING.has(f)) ? it.fails : it;

const repos: TempRepo[] = [];
let stubs: ToolStubs;
beforeAll(() => {
  stubs = installToolStubs();
});
afterAll(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

/** A repository with the full setup of both tools written the way `init --setup` writes it. */
async function setupRepo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await createTempRepo({
    files: {
      "README.md": "x\n",
      "src/app.ts": "export {};\n",
      "docs/adr/adr.toml": "[log]\n",
      "docs/issues/issues.toml": "[log]\n",
      ...files,
    },
  });
  repos.push(r);
  await applyBoth(r);
  return r;
}

/** Applies adr's and issues' setup, as running `adr init --setup` then `issues init --setup` does. */
async function applyBoth(r: TempRepo): Promise<void> {
  const pieces: SetupPiece[] = [];
  for (const [name, pkg, version] of [
    ["adr", "@nikovirtala/adr", ARK_PINS.adr],
    ["issues", "@nikovirtala/issues", ARK_PINS.issues],
  ] as const) {
    pieces.push(
      ...setupPieces(
        arkSetup({
          harnesses: [...HARNESSES],
          pkg,
          name,
          version,
          pins: ARK_PINS,
          logs: arkDefaultLogs(ARK_PINS),
        }),
      ),
    );
  }
  await applySetup(r.git, pieces, { tool: "adr" });
}

const executable = (root: string, file: string) => (statSync(join(root, file)).mode & 0o111) !== 0;

/** The repo-relative script a configured command runs: its last `.sh` word. */
const scriptOf = (command: string): string => {
  const m = /([\w./-]+\.sh)\b/.exec(command);
  if (m === null) throw new Error(`no script in ${command}`);
  return m[1] as string;
};

describe.each(HARNESSES)("%s: the generated setup, run as the harness runs it", (harness) => {
  const runtime: HarnessRuntime = HARNESS_RUNTIMES[harness as Harness];
  let r: TempRepo;
  beforeAll(async () => {
    r = await setupRepo();
  });
  const files = () => repoFiles(r.root);
  const hooks = (kind: string) => runtime.configuredHooks(files()).filter((h) => h.kind === kind);

  it("configures a session-start and a before-edit hook, in the documented shape", () => {
    expect(hooks("session-start")).toHaveLength(1);
    expect(hooks("before-edit")).toHaveLength(1);
    const servers = runtime.mcpServers(files());
    expect(servers.map((s) => s.name).sort()).toEqual(["adr", "issues"]);
    for (const s of servers) expect(s.args.join(" ")).toMatch(/@\d+\.\d+\.\d+ mcp$/);
  });

  // Claude Code's before-edit matcher missed NotebookEdit (?79); Kiro's `write` group covers its tools.
  (harness === "claude" ? checks("79") : it)(
    "matches every file-editing tool the harness has with its before-edit hook",
    () => {
      for (const hook of [...hooks("before-edit"), ...hooks("protect")]) {
        expect(runtime.uncoveredEditTools(hook), hook.file).toEqual([]);
      }
    },
  );

  checks("77")("writes every hook script as 100755 and runs it as `sh <script>`", () => {
    for (const hook of runtime.configuredHooks(files())) {
      expect(hook.command, hook.file).toMatch(/^sh /);
      expect(executable(r.root, scriptOf(hook.command)), scriptOf(hook.command)).toBe(true);
    }
  });

  checks("77")("runs the session-start hook: exit 0, in time, with plain-text context", () => {
    const [hook] = hooks("session-start");
    if (hook === undefined) throw new Error("no session-start hook");
    const run = runHook({
      runtime,
      root: r.root,
      hook,
      scenario: { kind: "session-start" },
      stubs,
    });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.ms / 1000).toBeLessThan(
      hook.timeoutSeconds ?? runtime.defaultTimeoutSeconds(hook.kind),
    );
    const context = runtime.contextOf("session-start", run.result);
    expect(context).toContain("Write the store");
    expect(context).toContain("Cache sessions");
  });

  describe.each(runtime.editTools)("before-edit hook on %s", (tool) => {
    const edit = (path: string) => ({ kind: "edit", tool, path: join(r.root, path) }) as const;

    checks("77", "79")(
      "hands the agent the records that govern the file, in the harness's format",
      () => {
        const [hook] = hooks("before-edit");
        if (hook === undefined) throw new Error("no before-edit hook");
        // Claude Code starts hooks in the session's directory, which may be a subdirectory.
        const run = runHook({
          runtime,
          root: r.root,
          hook,
          scenario: edit("src/app.ts"),
          stubs,
          cwd: join(r.root, "src"),
        });
        expect(run.result.status, run.result.stderr).toBe(0);
        expect(run.ms / 1000).toBeLessThan(
          hook.timeoutSeconds ?? runtime.defaultTimeoutSeconds("before-edit"),
        );
        const context = runtime.contextOf("before-edit", run.result);
        expect(context).toContain("ADR-0001");
        expect(context).toContain("src/app.ts");
        expect(context).not.toContain("no issues");
      },
    );
  });

  checks("77", "79")(
    "before-edit hook emits nothing when no record applies, for every edit tool",
    () => {
      const [hook] = hooks("before-edit");
      if (hook === undefined) throw new Error("no before-edit hook");
      for (const tool of runtime.editTools) {
        const scenario = { kind: "edit", tool, path: join(r.root, "README.md") } as const;
        const run = runHook({ runtime, root: r.root, hook, scenario, stubs });
        expect(run.result.status, `${tool}: ${run.result.stderr}`).toBe(0);
        expect(run.result.stdout.trim(), tool).toBe("");
      }
    },
  );

  describe("direct edits to the logs", () => {
    // Written out, not derived from the generator under test.
    const logPaths = [
      "docs/adr/events/abc12345/20261114T000000Z-x-proposed.yaml",
      "docs/adr/index.md",
      "docs/adr/decisions/abc12345-a-decision.md",
      "docs/issues/events/abc12345/20261114T000000Z-x-opened.yaml",
      "docs/issues/index.md",
    ];

    checks("80")("are refused whatever directory the session starts in", () => {
      const rules = runtime.denyRules(files());
      if (rules !== null) {
        // A rule file: every protected path matches an anchored deny rule, so no cwd matters.
        for (const p of logPaths) {
          expect(
            rules.some((g) => globMatches(g, p)),
            p,
          ).toBe(true);
        }
        return;
      }
      // No committed rule file: a PreToolUse hook blocks the write and names the tool.
      const [hook] = hooks("protect");
      if (hook === undefined) throw new Error("no protect hook");
      for (const tool of runtime.editTools) {
        for (const p of logPaths) {
          const run = runHook({
            runtime,
            root: r.root,
            hook,
            scenario: { kind: "edit", tool, path: join(r.root, p) },
            stubs,
          });
          const verdict = runtime.blocked(run.result);
          expect(verdict.blocked, `${tool} ${p}`).toBe(true);
          expect(verdict.message).toMatch(p.includes("/issues/") ? /issues/ : /adr/);
        }
      }
      const ok = runHook({
        runtime,
        root: r.root,
        hook,
        scenario: {
          kind: "edit",
          tool: runtime.editTools[0] as string,
          path: join(r.root, "src/app.ts"),
        },
        stubs,
      });
      expect(runtime.blocked(ok.result).blocked).toBe(false);
    });
  });

  checks("81")(
    "resolves the main ref the way numbering does, without assuming origin/main",
    async () => {
      const [hook] = hooks("session-start");
      if (hook === undefined) throw new Error("no session-start hook");
      // No remote: only the local main branch resolves. With a configured main_branch, that wins.
      const before = stubs.calls().length;
      runHook({ runtime, root: r.root, hook, scenario: { kind: "session-start" }, stubs });
      const since = (calls: string[]) => calls.filter((c) => /^adr list --since /.test(c));
      expect(since(stubs.calls().slice(before))).toEqual(["adr list --since refs/heads/main"]);

      await r.checkout("trunk", { create: true });
      await r.write("docs/adr/adr.toml", '[log]\nmain_branch = "trunk"\n');
      const mid = stubs.calls().length;
      runHook({ runtime, root: r.root, hook, scenario: { kind: "session-start" }, stubs });
      expect(since(stubs.calls().slice(mid))).toEqual(["adr list --since trunk"]);
      await r.checkout("main");
      await r.write("docs/adr/adr.toml", "[log]\n");
    },
  );

  describe("MCP servers and ARK_ON_BEHALF_OF", () => {
    const EMAIL = "niko@example.com";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder a harness leaves
    const LITERAL = "${ARK_ON_BEHALF_OF}";
    const cases: [string, Record<string, string | undefined>, string | null][] = [
      ["unset", {}, null],
      ["set", { ARK_ON_BEHALF_OF: EMAIL }, EMAIL],
      ["empty", { ARK_ON_BEHALF_OF: "" }, null],
    ];

    it("parses every server's config and pins an exact version (R4)", () => {
      for (const s of runtime.mcpServers(files())) {
        expect(s.command).toBe("npx");
        expect(s.env.ARK_AGENT).toBeTruthy();
        expect(JSON.stringify(s)).not.toContain(EMAIL);
      }
    });

    // An unset variable arrives as the text `${ARK_ON_BEHALF_OF}` unless the config gives a default.
    for (const [name, user, want] of cases) {
      (name === "unset" ? checks("78") : it)(
        `accepts the value the harness passes when the variable is ${name}`,
        () => {
          for (const s of runtime.mcpServers(files())) {
            const env = runtime.mcpEnv(s.env, user);
            expect(parseOnBehalfOf(env.ARK_ON_BEHALF_OF), `${harness} ${s.name}`).toBe(want);
          }
        },
      );
    }

    checks("78")("accepts the literal placeholder a harness leaves unexpanded", () => {
      expect(parseOnBehalfOf(LITERAL)).toBeNull();
    });
  });
});
