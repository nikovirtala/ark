import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// Loads the built entries, as a consumer of the package would.
const dist = (f: string) => new URL(`../dist/${f}`, import.meta.url);
for (const f of ["index.js", "testing.js", "cli.js", "mcp.js"]) {
  if (!existsSync(dist(f))) throw new Error(`dist/${f} is missing; run \`pnpm build\` first`);
}
const root = (await import(dist("index.js").href)) as typeof import("./index.js");
const testing = (await import(dist("testing.js").href)) as typeof import("./testing/index.js");
const cli = (await import(dist("cli.js").href)) as typeof import("./cli/index.js");
const mcp = (await import(dist("mcp.js").href)) as typeof import("./mcp/index.js");

// A resolve hook records every module the import resolves, then prints them.
const CHILD = `
import { registerHooks } from "node:module";
const urls = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    urls.push(r.url);
    return r;
  },
});
await import(process.env.ENTRY_URL);
process.stdout.write(JSON.stringify(urls));
`;

/** Every URL importing the built entry `f` resolves, in a fresh process. */
function resolvedBy(f: string): string[] {
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    encoding: "utf8",
    env: { ...process.env, ENTRY_URL: dist(f).href },
  });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as string[];
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("built entries", () => {
  it("share one error class hierarchy across the root and testing entries", async () => {
    const repo = await testing.createTempRepo({ files: { "a.txt": "a\n" } });
    cleanup.push(() => repo.dispose());
    const git = await root.Git.open(repo.root, repo.git.options);
    const thrown: unknown = await root.refReader(git, "-x").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(testing.LedgerError);
    expect(thrown).toBeInstanceOf(testing.InvalidArgumentError);
    expect(thrown).toBeInstanceOf(root.InvalidArgumentError);
    expect(testing.LedgerError).toBe(root.LedgerError);
    expect(testing.InvalidArgumentError).toBe(root.InvalidArgumentError);
  });

  it("share the error classes with the cli entry, so runCli recognizes the root's errors", async () => {
    expect(cli.LedgerError).toBe(root.LedgerError);
    expect(cli.UsageError).toBe(root.UsageError);
    const out: string[] = [];
    const err: string[] = [];
    let caught: unknown = null;
    const io = {
      argv: ["--json", "go"],
      cwd: process.cwd(),
      env: {},
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      interactive: false,
      stdoutIsTTY: false,
    };
    const run = async (): Promise<never> => {
      caught = new root.UsageError("thrown by the tool");
      throw caught;
    };
    const tool = {
      name: "t",
      version: "1.0.0",
      summary: "a test tool",
      commands: [
        {
          name: "go",
          summary: "go",
          usage: "go",
          options: {},
          positionals: { min: 0, max: 0, names: [] },
          ref: "reject" as const,
          run,
        },
      ],
    };
    expect(await cli.runCli(tool, io)).toBe(2);
    expect(caught).toBeInstanceOf(cli.LedgerError);
    expect(err.join("")).toBe("t: error: thrown by the tool\n");
    expect(JSON.parse(out.join(""))).toEqual({
      format: "ark-error/v1",
      error: { code: "usage", message: "thrown by the tool" },
    });
    // A usage error runCli raises itself is the root entry's class too.
    out.length = 0;
    expect(await cli.runCli(tool, { ...io, argv: ["--json", "nope"] })).toBe(2);
    expect(JSON.parse(out.join("")).error.code).toBe("usage");
  });

  it("share one git operation store across the entries", () => {
    const js = readdirSync(dist(".")).filter((f) => f.endsWith(".js"));
    const holders = js.filter((f) =>
      readFileSync(dist(f), "utf8").includes("new AsyncLocalStorage("),
    );
    expect(holders).toHaveLength(1);
  });
});

describe("the mcp entry", () => {
  it("shares the error classes with the root entry", () => {
    expect(mcp.LedgerError).toBe(root.LedgerError);
    expect(mcp.UsageError).toBe(root.UsageError);
  });

  it.each(["index.js", "cli.js", "testing.js"])(
    "isn't loaded by dist/%s, nor is the MCP SDK",
    (f) => {
      const urls = resolvedBy(f);
      expect(urls).toContain(dist(f).href);
      expect(urls).not.toContain(dist("mcp.js").href);
      expect(urls.filter((u) => u.includes("/@modelcontextprotocol/"))).toEqual([]);
    },
  );

  it("loads neither the cli nor the testing entry", () => {
    const urls = resolvedBy("mcp.js");
    expect(urls.some((u) => u.includes("/@modelcontextprotocol/"))).toBe(true);
    expect(urls).not.toContain(dist("cli.js").href);
    expect(urls).not.toContain(dist("testing.js").href);
  });
});
