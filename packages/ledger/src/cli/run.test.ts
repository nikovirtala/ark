import { describe, expect, it } from "vitest";
import { ConfigError, type JsonValue } from "../errors.js";
import { currentGitOperation, type GitOperation } from "../git/operation.js";
import type { CliIO } from "./output.js";
import { type CommandSpec, type Outcome, runCli, type ToolCli } from "./run.js";

const echo = (ctx: Parameters<CommandSpec["run"]>[0]): Outcome => ({
  exit: 0,
  json: {
    flags: { ...ctx.flags },
    values: ctx.values as Record<string, JsonValue>,
    positionals: [...ctx.positionals],
  },
  text: "shown",
});

const command = (o: Partial<CommandSpec> & Pick<CommandSpec, "name">): CommandSpec => ({
  summary: `${o.name} things`,
  usage: o.name,
  options: {},
  positionals: { min: 0, max: 0, names: [] },
  ref: "read",
  run: async (ctx) => echo(ctx),
  ...o,
});

const commands: readonly CommandSpec[] = [
  command({
    name: "show",
    usage: "show <subject> [--history] [--tag <tag>]...",
    options: { history: { type: "boolean" }, tag: { type: "string", multiple: true, short: "t" } },
    positionals: { min: 1, max: 1, names: ["subject"] },
  }),
  command({ name: "write", options: { commit: { type: "boolean" } }, ref: "reject" }),
  command({
    name: "fail",
    run: async () => ({ exit: 1, json: { ok: false }, text: "failed", notes: ["n1", "n2"] }),
  }),
  command({ name: "quiet", run: async () => ({ exit: 0, json: null, text: "" }) }),
  command({ name: "lines", run: async () => ({ exit: 0, json: [], text: "a\nb\n" }) }),
  command({
    name: "config",
    run: async () => {
      throw new ConfigError("adr.toml: bad key");
    },
  }),
  command({
    name: "boom",
    run: async () => {
      throw new Error("kaboom");
    },
  }),
];
const TOOL: ToolCli = { name: "t", version: "1.2.3", summary: "A test tool.", commands };

async function call(argv: readonly string[], tool: ToolCli = TOOL) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    argv,
    cwd: "/",
    env: {},
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
    },
    interactive: false,
    stdoutIsTTY: false,
  };
  const code = await runCli(tool, io);
  return { code, stdout, stderr };
}
const json = (s: string): unknown => JSON.parse(s);

describe("runCli tool check", () => {
  const cases: [what: string, commands: CommandSpec[], message: string][] = [
    [
      "a duplicate command",
      [command({ name: "a" }), command({ name: "a" })],
      "t: command a is defined twice",
    ],
    ["a command named help", [command({ name: "help" })], "t: the command name help is reserved"],
    ...["json", "root", "ref", "help", "version"].map((k): [string, CommandSpec[], string] => [
      `an option named ${k}`,
      [command({ name: "a", options: { [k]: { type: "boolean" } } })],
      `t a: --${k} is a global flag`,
    ]),
    ...["h", "V"].map((s): [string, CommandSpec[], string] => [
      `the short flag -${s}`,
      [command({ name: "a", options: { x: { type: "boolean", short: s } } })],
      `t a: -${s} is a global flag`,
    ]),
  ];
  it.each(cases)("refuses %s as an internal error", async (_, c, message) => {
    const r = await call(["--json", "a"], { ...TOOL, commands: c });
    expect(r.code).toBe(2);
    expect(r.stderr.startsWith(`t: internal error: ${message}\n`)).toBe(true);
    expect(json(r.stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "internal", message },
    });
  });
});

describe("runCli globals", () => {
  const flags = { json: true, root: "r", ref: "HEAD" };
  it.each([
    [["--json", "--root", "r", "--ref", "HEAD", "show", "x"]],
    [["show", "x", "--root", "r", "--ref", "HEAD", "--json"]],
    [["--root=r", "show", "--json", "x", "--ref=HEAD"]],
  ])("parses globals before and after the command: %j", async (argv) => {
    const r = await call(argv);
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(json(r.stdout)).toEqual({ flags, values: {}, positionals: ["x"] });
  });

  it("passes the command's own options without the globals", async () => {
    const r = await call(["--json", "show", "-t", "a", "x", "--tag=b", "--history"]);
    expect(json(r.stdout)).toEqual({
      flags: { json: true, root: null, ref: null },
      values: { tag: ["a", "b"], history: true },
      positionals: ["x"],
    });
    const negated = await call(["write", "--no-commit", "--json"]);
    expect(json(negated.stdout)).toMatchObject({ values: { commit: false } });
    const dashed = await call(["--json", "show", "--", "-x"]);
    expect(json(dashed.stdout)).toMatchObject({ positionals: ["-x"] });
  });

  it("prints text with a final newline and nothing for empty text", async () => {
    expect(await call(["show", "x"])).toEqual({ code: 0, stdout: "shown\n", stderr: "" });
    expect(await call(["lines"])).toEqual({ code: 0, stdout: "a\nb\n", stderr: "" });
    expect(await call(["quiet"])).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await call(["quiet", "--json"])).toEqual({ code: 0, stdout: "null\n", stderr: "" });
  });
});

describe("runCli usage errors", () => {
  it.each([
    [["nope"], `unknown command "nope"; run 't --help' for the commands`],
    [["show", "x", "--nope"], "Unknown option '--nope'"],
    [["--nope", "show", "x"], "Unknown option '--nope'"],
    [["--nope"], "Unknown option '--nope'"],
    [["show", "x", "--tag"], "Option '-t, --tag <value>' argument missing"],
    [["show", "x", "--history=yes"], "Option '--history' does not take an argument"],
    [["show"], "missing argument <subject>; usage: t show <subject> [--history] [--tag <tag>]..."],
    [["show", "a", "b"], 'unexpected argument "b"; usage: t show'],
    [["write", "x"], 'unexpected argument "x"; usage: t write'],
    [["write", "--ref", "HEAD"], "write does not take --ref; it works on the work tree"],
    [["--root", "", "show", "x"], "--root must not be empty"],
    [["--root=", "show", "x"], "--root must not be empty"],
    [["show", "x", "--ref", "  "], "--ref must not be empty"],
    [["help", "nope"], 'unknown command "nope"'],
    [["help", "show", "x"], 'unexpected argument "x"'],
    [["--", "show"], "Unexpected argument"],
  ])("%j exits 2", async (argv, message) => {
    const r = await call(argv);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith(`t: error: ${message}`)).toBe(true);
    expect(r.stderr.split("\n").filter((l) => l !== "")).toHaveLength(1);
  });

  it("prints usage on stderr and exits 2 without a command", async () => {
    const r = await call([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^Usage: t \[global options\] <command> \[options\]\n/);
    expect(r.stderr.endsWith("t: error: missing command\n")).toBe(true);
  });

  it("prints an ark-error/v1 document on stdout with --json", async () => {
    const r = await call(["--json", "nope"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe(
      `${JSON.stringify(
        {
          format: "ark-error/v1",
          error: {
            code: "usage",
            message: `unknown command "nope"; run 't --help' for the commands`,
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(json((await call(["show", "--json"])).stdout)).toMatchObject({
      error: { code: "usage" },
    });
    expect(json((await call(["--json"])).stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "usage", message: "missing command" },
    });
    // Before parsing fails, --json is taken from the arguments up to `--`.
    expect(json((await call(["show", "x", "--nope", "--json"])).stdout)).toMatchObject({
      error: { code: "usage" },
    });
    expect((await call(["show", "x", "--nope", "--", "--json"])).stdout).toBe("");
  });
});

describe("runCli help and version", () => {
  it.each([[["--version"]], [["-V"]], [["show", "--version"]], [["--json", "-V"]]])(
    "%j prints the version",
    async (argv) => {
      expect(await call(argv)).toEqual({ code: 0, stdout: "1.2.3\n", stderr: "" });
    },
  );

  it.each([[["--help"]], [["-h"]], [["help"]], [["--json", "help"]]])(
    "%j prints the tool's help",
    async (argv) => {
      const r = await call(argv);
      expect(r).toMatchObject({ code: 0, stderr: "" });
      expect(r.stdout).toMatch(
        /^Usage: t \[global options\] <command> \[options\]\n\nA test tool\.\n/,
      );
      expect(r.stdout).toContain("\n  show            show things\n");
      expect(r.stdout).toContain("\n  help [command]  show help for a command\n");
      expect(r.stdout).toContain("\n  --ref <ref>    read the log as of a git ref\n");
      expect(r.stdout.endsWith("\n")).toBe(true);
    },
  );

  it.each([[["show", "--help"]], [["show", "-h", "a", "b"]], [["help", "show"]]])(
    "%j prints the command's help, before the usage checks",
    async (argv) => {
      const r = await call(argv);
      expect(r).toMatchObject({ code: 0, stderr: "" });
      expect(r.stdout).toMatch(
        /^Usage: t show <subject> \[--history\] \[--tag <tag>\]\.\.\.\n\nshow things\n\nOptions:\n/,
      );
      expect(r.stdout).toContain("  --history\n");
      expect(r.stdout).toContain("  -t, --tag <value>  (repeatable)\n");
      expect(r.stdout).toContain("--ref <ref>");
    },
  );

  it("leaves --ref out of the help of a command that rejects it", async () => {
    const r = await call(["write", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--json");
    expect(r.stdout).not.toContain("--ref");
  });
});

describe("runCli outcomes", () => {
  it("prints notes on stderr as warnings, also with --json", async () => {
    expect(await call(["fail"])).toEqual({
      code: 1,
      stdout: "failed\n",
      stderr: "t: warning: n1\nt: warning: n2\n",
    });
    const r = await call(["fail", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout)).toEqual({ ok: false });
    expect(r.stderr).toBe("t: warning: n1\nt: warning: n2\n");
  });

  it("maps a LedgerError to exit 2 with its message and code", async () => {
    expect(await call(["config"])).toEqual({
      code: 2,
      stdout: "",
      stderr: "t: error: adr.toml: bad key\n",
    });
    expect(json((await call(["config", "--json"])).stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "config", message: "adr.toml: bad key" },
    });
  });

  it("maps an unexpected error to exit 2 as an internal error with the stack", async () => {
    const r = await call(["boom"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^t: internal error: kaboom\nError: kaboom\n\s+at /);
    expect(json((await call(["--json", "boom"])).stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "internal", message: "kaboom" },
    });
  });

  it("exits 0 on success", async () => {
    expect((await call(["show", "x"])).code).toBe(0);
  });
});

describe("runCli git operation", () => {
  it("runs the command in a git operation and closes it after", async () => {
    let seen = null as GitOperation | null;
    const op = command({
      name: "op",
      run: async (ctx) => {
        seen = currentGitOperation();
        return echo(ctx);
      },
    });
    expect((await call(["op"], { ...TOOL, commands: [op] })).code).toBe(0);
    expect(seen).not.toBeNull();
    expect(seen?.closed).toBe(true);
    expect(currentGitOperation()).toBeNull();
  });
});
