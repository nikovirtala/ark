import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CLI, cliRepo, requireBuilt, runIssues, runJson } from "./test-support/cli.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const node = (args: string[]) =>
  spawnSync(process.execPath, [requireBuilt(CLI), ...args], { encoding: "utf8" });

describe("the issues binary", () => {
  it("prints its version with -V and --version", () => {
    for (const flag of ["-V", "--version"]) {
      const r = node([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(version);
    }
  });

  it("exits 2 without a command, with the usage on stderr", () => {
    const r = node([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Usage: issues [global options] <command> [options]");
    expect(r.stderr).toContain("issues: error: missing command");
  });

  it("lists the commands in order in --help", () => {
    const r = node(["--help"]);
    expect(r.status).toBe(0);
    const names = r.stdout
      .split("\n")
      .slice(r.stdout.split("\n").indexOf("Commands:") + 1)
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim().split(/\s+/)[0]);
    expect(names.slice(0, names.indexOf("help"))).toEqual([
      "init",
      "new",
      "edit",
      "start",
      "stop",
      "close",
      "reopen",
      "assign",
      "label",
      "comment",
      "link",
      "unlink",
      "scope",
      "index",
      "for",
      "ready",
      "work",
      "list",
      "show",
      "search",
      "verify",
      "sources",
      "hooks",
      "mcp",
    ]);
  });

  it("is an executable node script", () => {
    expect(readFileSync(CLI, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("tells the developer to build first", () => {
    expect(() => requireBuilt("/nonexistent/dist/cli.js")).toThrow("run `pnpm build` first");
  });

  it("prints ark-error/v1 with --json when it can't run", async () => {
    await using repo = await cliRepo();
    const r = runJson<{ format: string; error: { code: string; message: string } }>(repo, [
      "show",
      "zzzzzzzz",
    ]);
    expect(r.status).toBe(2);
    expect(r.json).toMatchObject({
      format: "ark-error/v1",
      error: { message: "unknown issue zzzzzzzz" },
    });
  });

  it('accepts [log] index = "committed"', async () => {
    await using repo = await cliRepo({ "docs/issues/issues.toml": '[log]\nindex = "committed"\n' });
    expect(runIssues(repo, ["list"]).status).toBe(0);
    expect(runIssues(repo, ["index"]).status).toBe(0);
    expect(runIssues(repo, ["index", "--check"]).status).toBe(0);
  });
});
