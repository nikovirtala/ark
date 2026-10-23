import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr, seedDecision } from "../test-support/cli.js";
import { decisionEvent, eventFile } from "../test-support/events.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}
const bodyOf = (id: string) => `docs/adr/decisions/${id}-use-dynamodb-for-orders.md`;
/** A second accepted event on `id`: transition/illegal. */
const illegalAccept = (id: string) =>
  eventFile(
    decisionEvent(id, "accepted", {
      data: { body_sha256: "0".repeat(64) },
      at: "2099-01-01T00:00:00Z",
    }),
  );

describe("adr verify", { timeout: 60_000 }, () => {
  it("exits 0 on a clean log, in text and JSON", async () => {
    const r = await repo();
    await seedDecision(r, "Use DynamoDB for orders");
    expect(runAdr(r, ["verify"])).toEqual({ status: 0, stdout: "No findings.\n", stderr: "" });
    const out = runAdr(r, ["verify", "--json"]);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      format: "ledger-findings/v1",
      ok: true,
      summary: { errors: 0, warnings: 0 },
      findings: [],
    });
    expect(runAdr(r, ["verify", "--format", "json"]).stdout).toBe(out.stdout);
  });

  it("exits 1 when an accepted body changed, and verifies a ref as head", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB for orders");
    await appendFile(join(r.root, bodyOf(a)), "tampered\n");
    const out = runAdr(r, ["verify"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(
      new RegExp(
        `^docs/adr/events/${a}/\\S+-accepted\\.yaml: error: .*\\[body/hash-mismatch\\] \\(${a}\\)$`,
        "m",
      ),
    );
    const github = runAdr(r, ["verify", "--format", "github"]);
    expect(github.status).toBe(1);
    expect(github.stdout).toMatch(/^::error file=/m);
    expect(runAdr(r, ["verify", "--ref", "HEAD"]).status).toBe(0);
  });

  it("checks staged changes with --staged and a range with --base", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB for orders");
    const [path, content] = illegalAccept(a);
    await r.write(path, content);
    expect(runAdr(r, ["verify", "--staged"])).toEqual({
      status: 0,
      stdout: "No findings.\n",
      stderr: "",
    });
    await r.stage(path);
    const staged = runAdr(r, ["verify", "--staged", "--json"]);
    expect(staged.status).toBe(1);
    expect(JSON.parse(staged.stdout).findings).toContainEqual(
      expect.objectContaining({ rule: "transition/illegal", file: path, subject: a }),
    );
    const range = runAdr(r, ["verify", "--base", "main"]);
    expect(range.status).toBe(1);
    expect(range.stdout).toContain("[transition/illegal]");
  });

  it("exits 2 for conflicting flags, with an ark-error/v1 document on --json", async () => {
    const r = await repo();
    expect(runAdr(r, ["verify", "--staged", "--base", "main"])).toEqual({
      status: 2,
      stdout: "",
      stderr: "adr: error: --staged can't be combined with --base or --ref\n",
    });
    const json = runAdr(r, ["verify", "--staged", "--base", "main", "--json"]);
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "usage", message: "--staged can't be combined with --base or --ref" },
    });
    expect(runAdr(r, ["verify", "--ref", "nope"]).status).toBe(2);
  });

  it("fails on warnings when adr.toml sets fail_on", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB for orders");
    await r.write(`docs/adr/events/${a}/notes.txt`, "notes\n");
    const lenient = runAdr(r, ["verify"]);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("[identity/stray-file]");
    await r.write("docs/adr/adr.toml", '[verify]\nfail_on = "warning"\n');
    expect(runAdr(r, ["verify"]).status).toBe(1);
  });
});
