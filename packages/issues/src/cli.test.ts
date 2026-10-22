import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

it("prints its version with --version", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(version);
});

it("exits 2 without arguments", () => {
  const result = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  expect(result.status).toBe(2);
});
