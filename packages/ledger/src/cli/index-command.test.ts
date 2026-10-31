import { describe, expect, it } from "vitest";
import { finding } from "../findings/finding.js";
import type { IndexRun, LogIndexJson, ToolWriteOptions } from "../surfaces/tool-index.js";
import { type IndexCommandOptions, indexCommand } from "./index-command.js";
import { runCli } from "./run.js";

const PATH = "log/index.md";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const doc = (o: Partial<LogIndexJson> = {}): LogIndexJson => ({
  format: "w-index/v1",
  path: PATH,
  check: false,
  fresh: false,
  written: [],
  commit: null,
  findings: [],
  notes: [],
  ...o,
});

const stale = finding({
  severity: "error",
  rule: "index/stale",
  message: `${PATH} is not what the tool generates; run w index and commit it`,
  file: PATH,
  subject: null,
});

async function call(
  argv: readonly string[],
  o: {
    run?: IndexRun;
    autoCommit?: boolean;
    failOn?: "error" | "warning";
    checkHelp?: string;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const calls: (ToolWriteOptions & { check?: boolean })[] = [];
  const options: IndexCommandOptions = {
    tool: "w",
    noun: "widget",
    ...(o.checkHelp === undefined ? {} : { checkHelp: o.checkHelp }),
    async open() {
      return {
        autoCommit: o.autoCommit ?? false,
        failOn: o.failOn ?? "error",
        async run(opts) {
          calls.push(opts);
          return o.run ?? { doc: doc(), refreshed: false };
        },
      };
    },
  };
  const code = await runCli(
    { name: "w", version: "0.0.0", summary: "widgets", commands: [indexCommand(options)] },
    {
      argv,
      cwd: process.cwd(),
      env: {},
      stdout: {
        write: (x) => {
          stdout += x;
        },
      },
      stderr: {
        write: (x) => {
          stderr += x;
        },
      },
      interactive: false,
      stdoutIsTTY: false,
    },
  );
  return { code, stdout, stderr, calls };
}

describe("indexCommand", () => {
  it.each([
    [{ doc: doc({ check: true, fresh: true }), refreshed: false }, `${PATH} is up to date`],
    [
      { doc: doc({ commit: SHA, written: [PATH] }), refreshed: false },
      `Committed ${PATH} as 0123456`,
    ],
    [
      { doc: doc({ commit: SHA, written: [PATH] }), refreshed: true },
      `Committed ${PATH} as 0123456\nWrote ${PATH} with uncommitted log changes`,
    ],
    [
      { doc: doc({ fresh: true, written: [PATH] }), refreshed: true },
      `${PATH} is up to date in HEAD; wrote the work tree's copy, which includes uncommitted log changes`,
    ],
    [{ doc: doc({ fresh: true }), refreshed: false }, `${PATH} is up to date`],
    [{ doc: doc({ written: [PATH] }), refreshed: false }, `Wrote ${PATH}`],
    [{ doc: doc(), refreshed: false }, `Staged ${PATH}`],
  ])("prints the run %#", async (run, text) => {
    const r = await call(["index"], { run });
    expect(r).toMatchObject({ code: 0, stdout: `${text}\n`, stderr: "" });
  });

  it("prints --check's findings and exits by failOn", async () => {
    const run = { doc: doc({ check: true, findings: [stale] }), refreshed: false };
    const r = await call(["index", "--check"], { run });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("index/stale");
    expect(r.calls).toEqual([{ check: true }]);
    const warning = { ...stale, severity: "warning" as const };
    const warned = { doc: doc({ check: true, findings: [warning] }), refreshed: false };
    expect((await call(["index", "--check"], { run: warned })).code).toBe(0);
    expect((await call(["index", "--check"], { run: warned, failOn: "warning" })).code).toBe(1);
  });

  it("prints the JSON document and the notes", async () => {
    const run = { doc: doc({ written: [PATH], notes: ["a note"] }), refreshed: false };
    const r = await call(["--json", "index"], { run });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(run.doc);
    expect(r.stderr).toContain("a note");
  });

  it("passes the commit choice", async () => {
    expect((await call(["index"])).calls).toEqual([{ check: false, commit: false, message: null }]);
    expect((await call(["index"], { autoCommit: true })).calls).toEqual([
      { check: false, commit: true, message: null },
    ]);
    expect((await call(["index", "--commit", "-m", "chore: x"])).calls).toEqual([
      { check: false, commit: true, message: "chore: x" },
    ]);
  });

  it.each([
    [["index", "--check", "--commit"], "--check writes nothing; drop --commit and --message"],
    [["index", "--check", "-m", "x"], "--check writes nothing; drop --commit and --message"],
    [["--ref", "HEAD", "index"], "w index writes the work tree; use --ref only with --check"],
  ])("%j is a usage error", async (argv, message) => {
    const r = await call(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.calls).toEqual([]);
  });

  it("describes --check with checkHelp only", async () => {
    const plain = await call(["index", "--help"]);
    expect(plain.stdout).toMatch(
      /^Usage: w index \[--check\] \[--commit \| --no-commit\] \[-m <message>\]\n\nregenerate the widget index \(index\.md\), or check that it is current\n/,
    );
    expect(plain.stdout).toContain("\n  --check\n");
    const described = await call(["index", "--help"], { checkHelp: "check it instead" });
    expect(described.stdout).toMatch(/\n {2}--check +check it instead\n/);
    expect(
      indexCommand({ tool: "w", noun: "widget", open: async () => never() }).options.check,
    ).toEqual({
      type: "boolean",
    });
  });
});

function never(): never {
  throw new Error("not opened");
}
