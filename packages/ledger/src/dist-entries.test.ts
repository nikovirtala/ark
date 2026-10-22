import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// Loads the built entries, as a consumer of the package would.
const dist = (f: string) => new URL(`../dist/${f}`, import.meta.url);
for (const f of ["index.js", "testing.js"]) {
  if (!existsSync(dist(f))) throw new Error(`dist/${f} is missing; run \`pnpm build\` first`);
}
const root = (await import(dist("index.js").href)) as typeof import("./index.js");
const testing = (await import(dist("testing.js").href)) as typeof import("./testing/index.js");

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("built entries", () => {
  it("share one error class hierarchy across the root and testing entries", async () => {
    const repo = await testing.createTempRepo({ files: { "a.txt": "a\n" } });
    cleanup.push(() => repo.dispose());
    const git = await root.Git.open(repo.root);
    const thrown: unknown = await root.refReader(git, "-x").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(testing.LedgerError);
    expect(thrown).toBeInstanceOf(testing.InvalidArgumentError);
    expect(thrown).toBeInstanceOf(root.InvalidArgumentError);
    expect(testing.LedgerError).toBe(root.LedgerError);
    expect(testing.InvalidArgumentError).toBe(root.InvalidArgumentError);
  });
});
