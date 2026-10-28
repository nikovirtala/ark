import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runIssues } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}

describe("issues mcp", { timeout: 60_000 }, () => {
  it("refuses --json and --ref", async () => {
    const r = await repo();
    const j = runIssues(r, ["mcp", "--json"]);
    expect(j.status).toBe(2);
    expect(j.stderr).toBe(
      "issues: error: issues mcp speaks JSON-RPC on stdout; it takes no --json\n",
    );
    const ref = runIssues(r, ["mcp", "--ref", "HEAD"]);
    expect(ref.status).toBe(2);
    expect(ref.stderr).toContain("mcp does not take --ref");
  });

  it("exits 2 before serving with an invalid ARK_ON_BEHALF_OF", async () => {
    const r = await repo();
    const out = runIssues(r, ["mcp"], { env: { ARK_ON_BEHALF_OF: "not-an-email" } });
    expect(out).toEqual({
      status: 2,
      stdout: "",
      stderr: 'issues: error: ARK_ON_BEHALF_OF "not-an-email" is not an email address\n',
    });
  });

  it("exits 2 before serving outside a repository and with a bad issues.toml", async () => {
    const r = await repo({ "docs/issues/issues.toml": "[log\n" });
    const bad = runIssues(r, ["mcp"]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/^issues: error: /);
    const dir = await mkdtemp(join(tmpdir(), "issues-mcp-"));
    try {
      const out = runIssues(r, ["mcp"], { cwd: dir });
      expect(out.status).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toMatch(/^issues: error: /);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 when stdin is closed, writing nothing to stdout", async () => {
    const r = await repo();
    expect(runIssues(r, ["mcp"])).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});
