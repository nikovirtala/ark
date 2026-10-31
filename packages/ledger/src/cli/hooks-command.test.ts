import { describe, expect, it } from "vitest";
import { finding } from "../findings/finding.js";
import type { ToolHooksJson } from "../surfaces/tool-hooks.js";
import { type HooksCommandOptions, hooksCommand } from "./hooks-command.js";
import { runCli } from "./run.js";

type Log = { readonly notes: readonly string[]; readonly reader: "worktree" | "index" };

const doc = (o: Partial<ToolHooksJson> = {}): ToolHooksJson => ({
  format: "w-hooks/v1",
  action: "install",
  written: [],
  unchanged: [],
  registrations: [
    { hook: "pre-commit", argv: ["hooks", "run", "pre-commit"] },
    { hook: "commit-msg", argv: ["hooks", "trailers", "{args}"] },
  ],
  snippet: null,
  trailers: [],
  ...o,
});

async function call(
  argv: readonly string[],
  o: {
    manager?: HooksCommandOptions<Log>["manager"];
    possessive?: string;
    doc?: ToolHooksJson & { notes?: readonly string[] };
    exit?: 0 | 1;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const calls: unknown[] = [];
  const result = o.doc ?? doc();
  const options: HooksCommandOptions<Log> = {
    tool: "w",
    ...(o.manager === undefined ? {} : { manager: o.manager }),
    ...(o.possessive === undefined ? {} : { possessive: o.possessive }),
    async open({ reader }) {
      return { notes: [`opened ${reader}`], reader };
    },
    async install(log) {
      calls.push(["install", log.reader]);
      return result;
    },
    async uninstall(log) {
      calls.push(["uninstall", log.reader]);
      return result;
    },
    print(log, manager) {
      calls.push(["print", log.reader, manager]);
      return result;
    },
    async preCommit({ worktree, index }) {
      calls.push(["run", worktree.reader, index.reader]);
      const findings =
        o.exit === 1
          ? [finding({ severity: "error", rule: "x/y", message: "bad", file: null, subject: null })]
          : [];
      return { exit: o.exit ?? 0, findings, notes: ["pre-commit note"], failOn: "error" };
    },
    async trailers(log, file) {
      calls.push(["trailers", log.reader, file]);
      return result;
    },
  };
  const io = {
    argv,
    cwd: "/repo",
    env: {},
    stdout: {
      write: (x: string) => {
        stdout += x;
      },
    },
    stderr: {
      write: (x: string) => {
        stderr += x;
      },
    },
    interactive: false,
    stdoutIsTTY: false,
  };
  const code = await runCli(
    { name: "w", version: "0.0.0", summary: "widgets", commands: [hooksCommand(options)] },
    io,
  );
  return { code, stdout, stderr, calls };
}

describe("hooksCommand", () => {
  it("prints the shims written and unchanged in hook order, then the hooks", async () => {
    const r = await call(["hooks", "install"], {
      doc: doc({ written: [".git/hooks/commit-msg"], unchanged: [".git/hooks/pre-commit"] }),
    });
    expect(r).toMatchObject({
      code: 0,
      stdout:
        "unchanged .git/hooks/pre-commit\nwrote .git/hooks/commit-msg\nw hooks: pre-commit, commit-msg\n",
    });
    expect(r.stderr).toContain("opened worktree");
    expect(r.calls).toEqual([["install", "worktree"]]);
  });

  it("prints what uninstall removed, or that nothing was installed", async () => {
    expect((await call(["hooks", "uninstall"])).stdout).toBe("w hooks were not installed\n");
    const r = await call(["hooks", "uninstall"], {
      doc: doc({ action: "uninstall", written: [".git/hooks/pre-commit"] }),
    });
    expect(r.stdout).toBe("removed w from .git/hooks/pre-commit\n");
  });

  it("prints the snippet of a known manager", async () => {
    const r = await call(["hooks", "print", "--manager", "husky"], {
      doc: doc({ action: "print", snippet: "the snippet" }),
    });
    expect(r).toMatchObject({ code: 0, stdout: "the snippet\n" });
    expect(r.calls).toEqual([["print", "worktree", "husky"]]);
  });

  it("runs pre-commit on both logs and exits by its result", async () => {
    const ok = await call(["hooks", "run", "pre-commit"]);
    expect(ok).toMatchObject({ code: 0, stdout: "" });
    expect(ok.stderr).toContain("pre-commit note");
    expect(ok.calls).toEqual([["run", "worktree", "index"]]);
    const failed = await call(["--json", "hooks", "run", "pre-commit"], { exit: 1 });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ format: "ledger-findings/v1" });
  });

  it("passes the message file resolved against cwd, with the log's notes, then the doc's", async () => {
    const r = await call(["--json", "hooks", "trailers", ".git/COMMIT_EDITMSG"], {
      doc: { ...doc({ action: "trailers" }), notes: ["doc note"] },
    });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([["trailers", "worktree", "/repo/.git/COMMIT_EDITMSG"]]);
    expect(r.stderr.indexOf("opened worktree")).toBeLessThan(r.stderr.indexOf("doc note"));
    expect(r.stderr.indexOf("opened worktree")).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [
      ["hooks", "install", "--manager", "husky"],
      "--manager goes with hooks print only; usage: w hooks install",
    ],
    [["hooks", "install", "x"], 'unexpected argument "x"; usage: w hooks install'],
    [["hooks", "print"], "hooks print needs --manager lefthook, husky or pre-commit"],
    [
      ["hooks", "print", "--manager", "nope"],
      'unknown hook manager "nope"; use lefthook, husky or pre-commit',
    ],
    [["hooks", "run", "pre-push"], "w hooks run supports pre-commit"],
    [["hooks", "trailers"], "missing argument <message-file>; usage: w hooks install"],
    [["hooks", "go"], 'unknown hooks action "go"; use install, uninstall, print, run or trailers'],
  ])("%j is a usage error", async (argv, message) => {
    const r = await call(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.calls).toEqual([]);
  });

  it("gives --manager a placeholder and help line only when the tool passes them", async () => {
    const plain = await call(["hooks", "--help"]);
    expect(plain.stdout).toContain("install, remove or print w's git hooks, and run their steps");
    expect(plain.stdout).toMatch(/--manager <value>\s*\n/);
    const helped = await call(["hooks", "--help"], {
      manager: { value: "<manager>", help: "lefthook, husky or pre-commit (hooks print only)" },
      possessive: "ws'",
    });
    expect(helped.stdout).toContain("install, remove or print ws' git hooks, and run their steps");
    expect(helped.stdout).toMatch(
      /--manager <manager>\s+lefthook, husky or pre-commit \(hooks print only\)/,
    );
  });
});
