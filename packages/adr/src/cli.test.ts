import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CLI, requireBuilt } from "./test-support/cli.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const run = (...args: string[]) =>
  spawnSync(process.execPath, [requireBuilt(CLI), ...args], { encoding: "utf8" });

describe("the adr binary", () => {
  it("prints its version with --version", () => {
    const result = run("--version");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  it("exits 2 without arguments, with the usage on stderr", () => {
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: adr [global options] <command> [options]");
    expect(result.stderr).toContain("adr: error: missing command");
  });

  it("lists its commands with --help, in order", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    const listed = [...result.stdout.matchAll(/^ {2}([a-z]+) {2,}/gm)].map((m) => m[1]);
    expect(listed).toEqual([
      "init",
      "new",
      "accept",
      "reject",
      "withdraw",
      "deprecate",
      "supersede",
      "note",
      "link",
      "scope",
      "for",
      "list",
      "show",
      "verify",
    ]);
  });

  it("starts with the node shebang, so npm can link it as a bin", () => {
    expect(readFileSync(requireBuilt(CLI), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("tells the developer to build first when dist is missing", () => {
    expect(() => requireBuilt("/nonexistent/dist/cli.js")).toThrow(
      "/nonexistent/dist/cli.js is missing; run `pnpm build` first",
    );
  });
});
