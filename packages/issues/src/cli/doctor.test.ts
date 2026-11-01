import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { hooksRepo, runIssues } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await hooksRepo();
  repos.push(r);
  return r;
}

/** `issues init --setup --no-commit`: writes ark's whole agent setup into the work tree. */
function setUp(r: TempRepo): void {
  const out = runIssues(r, ["init", "--setup", "--no-commit"]);
  expect(out.status, out.stderr).toBe(0);
}

// ?60 (ram953kt), design "doctor": R5 and R6.
describe("issues doctor", { timeout: 120_000 }, () => {
  it("reports a complete setup and exits 0", async () => {
    const r = await repo();
    setUp(r);
    const out = runIssues(r, ["doctor"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("issues: agent setup is complete");
  });

  it("exits 1 and names the fixing command when a piece is missing (R5)", async () => {
    const r = await repo();
    setUp(r);
    await rm(join(r.root, ".claude/hooks/session-start.sh"), { force: true });
    const out = runIssues(r, ["doctor"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain(".claude/hooks/session-start.sh");
    expect(out.stdout).toContain("issues init --setup");
    const json = JSON.parse(runIssues(r, ["doctor", "--json"]).stdout);
    expect(json.format).toBe("issues-doctor/v1");
    expect(json.exit).toBe(1);
    expect(json.gaps.some((g: { kind: string }) => g.kind === "missing")).toBe(true);
  });

  it("installs this clone's git hooks with --fix-clone (R6)", async () => {
    const r = await repo();
    setUp(r);
    for (const h of ["pre-commit", "commit-msg", "pre-push", "post-merge"]) {
      expect(existsSync(join(r.git.gitDir, "hooks", h))).toBe(false);
    }
    const out = runIssues(r, ["doctor", "--fix-clone"]);
    expect(out.status, out.stderr).toBe(0);
    for (const h of ["pre-commit", "commit-msg", "pre-push", "post-merge"]) {
      expect(existsSync(join(r.git.gitDir, "hooks", h))).toBe(true);
    }
  });
});
