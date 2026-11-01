import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { hooksRepo, runAdr } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await hooksRepo();
  repos.push(r);
  return r;
}

/** `adr init --setup --no-commit`: writes ark's whole agent setup into the work tree. */
function setUp(r: TempRepo): void {
  const out = runAdr(r, ["init", "--setup", "--no-commit"]);
  expect(out.status, out.stderr).toBe(0);
}

// ?60 (ram953kt), design "doctor": R5 and R6.
describe("adr doctor", { timeout: 120_000 }, () => {
  it("reports a complete setup and exits 0", async () => {
    const r = await repo();
    setUp(r);
    const out = runAdr(r, ["doctor"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("adr: agent setup is complete");
  });

  it("exits 1 and names the fixing command when a piece is missing (R5)", async () => {
    const r = await repo();
    setUp(r);
    await rm(join(r.root, ".claude/hooks/session-start.sh"), { force: true });
    const out = runAdr(r, ["doctor"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain(".claude/hooks/session-start.sh");
    expect(out.stdout).toContain("adr init --setup");
    const json = JSON.parse(runAdr(r, ["doctor", "--json"]).stdout);
    expect(json.format).toBe("adr-doctor/v1");
    expect(json.exit).toBe(1);
    expect(json.gaps.some((g: { kind: string }) => g.kind === "missing")).toBe(true);
  });

  it("reports a piece someone changed as 'changed', without exiting 1", async () => {
    const r = await repo();
    setUp(r);
    await r.write(".claude/settings.json", "{}\n");
    const json = JSON.parse(runAdr(r, ["doctor", "--json"]).stdout);
    // Only the hand-edited settings is a changed gap; nothing is missing, so exit 0.
    expect(json.exit).toBe(0);
    const settings = json.gaps.find((g: { id: string }) => g.id === "claude.settings") as
      | { kind: string }
      | undefined;
    expect(settings?.kind).toBe("changed");
  });

  it("installs this clone's git hooks with --fix-clone (R6)", async () => {
    const r = await repo();
    setUp(r);
    for (const h of ["pre-commit", "commit-msg", "pre-push", "post-merge"]) {
      expect(existsSync(join(r.git.gitDir, "hooks", h))).toBe(false);
    }
    const out = runAdr(r, ["doctor", "--fix-clone"]);
    expect(out.status, out.stderr).toBe(0);
    for (const h of ["pre-commit", "commit-msg", "pre-push", "post-merge"]) {
      expect(existsSync(join(r.git.gitDir, "hooks", h))).toBe(true);
    }
  });
});
