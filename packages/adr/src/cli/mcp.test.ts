import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await cliRepo();
  repos.push(r);
  return r;
}

describe("adr mcp", { timeout: 60_000 }, () => {
  it("refuses --json and --ref", async () => {
    const r = await repo();
    const j = runAdr(r, ["mcp", "--json"]);
    expect(j.status).toBe(2);
    expect(j.stderr).toBe("adr: error: adr mcp speaks JSON-RPC on stdout; it takes no --json\n");
    const ref = runAdr(r, ["mcp", "--ref", "HEAD"]);
    expect(ref.status).toBe(2);
    expect(ref.stderr).toContain("mcp does not take --ref");
  });

  it("exits 2 before serving with an invalid ARK_ON_BEHALF_OF", async () => {
    const r = await repo();
    const out = runAdr(r, ["mcp"], { env: { ARK_ON_BEHALF_OF: "not-an-email" } });
    expect(out).toEqual({
      status: 2,
      stdout: "",
      stderr: 'adr: error: ARK_ON_BEHALF_OF "not-an-email" is not an email address\n',
    });
  });

  it("exits 0 when stdin is closed, writing nothing to stdout", async () => {
    const r = await repo();
    expect(runAdr(r, ["mcp"])).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});
