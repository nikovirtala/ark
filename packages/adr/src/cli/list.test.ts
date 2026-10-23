import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr, seedDecision, seedSupersession } from "../test-support/cli.js";
import { decisionEvent, eventFile } from "../test-support/events.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(...args: Parameters<typeof cliRepo>): Promise<TempRepo> {
  const r = await cliRepo(...args);
  repos.push(r);
  return r;
}
const head = async (r: TempRepo) =>
  Buffer.from((await r.git.run(["rev-parse", "HEAD"])).stdout)
    .toString("utf8")
    .trim();

/** Three decisions: A superseded by B (ADR-0001, ADR-0002), and C proposed. */
async function threeDecisions(r: TempRepo) {
  const a = await seedDecision(r, "Use DynamoDB for orders");
  const afterA = await head(r);
  const b = await seedDecision(r, "Use Aurora for orders");
  await seedSupersession(r, a, b);
  const c = await seedDecision(r, "Adopt event sourcing", { accept: false });
  return { a, b, c, afterA };
}

describe("adr list", { timeout: 60_000 }, () => {
  it("prints one padded row per decision in list order", async () => {
    const r = await repo();
    const { a, b, c } = await threeDecisions(r);
    const out = runAdr(r, ["list"]);
    expect(out).toEqual({
      status: 0,
      stderr: "",
      stdout: [
        `ADR-0001  ${a}  superseded  Use DynamoDB for orders  → ADR-0002`,
        `ADR-0002  ${b}  accepted    Use Aurora for orders`,
        `-         ${c}  proposed    Adopt event sourcing`,
        "",
      ].join("\n"),
    });
  });

  it("prints the adr-list/v1 document with --json", async () => {
    const r = await repo();
    const { a, b, c } = await threeDecisions(r);
    const out = runAdr(r, ["list", "--json"]);
    expect(out.status).toBe(0);
    const doc = JSON.parse(out.stdout);
    expect(Object.keys(doc)).toEqual([
      "format",
      "root",
      "ref",
      "commit",
      "numbering",
      "decisions",
      "unreadable",
      "unfoldable",
      "findings",
      "notes",
    ]);
    expect(doc).toMatchObject({
      format: "adr-list/v1",
      root: "docs/adr",
      ref: null,
      commit: await head(r),
      numbering: { available: true, reason: null, ref: "refs/heads/main" },
      unreadable: [],
      unfoldable: [],
      findings: [],
      notes: [],
    });
    expect(doc.decisions.map((v: { id: string }) => v.id)).toEqual([a, b, c]);
    expect(doc.decisions[0]).toMatchObject({
      display: "ADR-0001",
      status: "superseded",
      effective: b,
      chain: [a, b],
    });
  });

  it("filters by --status and refuses an unknown status", async () => {
    const r = await repo();
    const { b, c } = await threeDecisions(r);
    const out = runAdr(r, ["list", "--status", "accepted", "--status", "proposed", "--json"]);
    expect(JSON.parse(out.stdout).decisions.map((v: { id: string }) => v.id)).toEqual([b, c]);

    const bad = runAdr(r, ["list", "--status", "bogus"]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toBe(
      'adr: error: unknown status "bogus"; use one of proposed, accepted, rejected, withdrawn, deprecated, superseded\n',
    );
    const json = runAdr(r, ["list", "--status", "bogus", "--json"]);
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({
      format: "ark-error/v1",
      error: {
        code: "usage",
        message:
          'unknown status "bogus"; use one of proposed, accepted, rejected, withdrawn, deprecated, superseded',
      },
    });
  });

  it("says so for an empty log", async () => {
    const r = await repo();
    expect(runAdr(r, ["list"])).toEqual({ status: 0, stdout: "No decisions.\n", stderr: "" });
  });

  it("reads the log as of --ref", async () => {
    const r = await repo();
    const { a, afterA } = await threeDecisions(r);
    const out = runAdr(r, ["list", "--ref", afterA]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`ADR-0001  ${a}  accepted  Use DynamoDB for orders\n`);
    const doc = JSON.parse(runAdr(r, ["list", "--ref", afterA, "--json"]).stdout);
    expect(doc).toMatchObject({ ref: afterA, commit: afterA });
  });

  it("notes a repo adr.toml that --root overrides, on stderr and in notes", async () => {
    const r = await repo({ "adr.toml": '[log]\nroot = "docs/adr"\n' });
    const note = "ignoring adr.toml (its root is docs/adr; --root is fixtures/adr)";
    expect(runAdr(r, ["list", "--root", "fixtures/adr"])).toEqual({
      status: 0,
      stdout: "No decisions.\n",
      stderr: `adr: warning: ${note}\n`,
    });
    const out = runAdr(r, ["list", "--root", "fixtures/adr", "--json"]);
    expect(JSON.parse(out.stdout)).toMatchObject({ root: "fixtures/adr", notes: [note] });
    expect(out.stderr).toBe(`adr: warning: ${note}\n`);
  });

  it("notes unavailable numbers, problems and unreadable subjects", async () => {
    const r = await repo({}, { initialBranch: "trunk" });
    const a = await seedDecision(r, "Use DynamoDB for orders");
    // A second accepted event is illegal (transition/illegal); a body without events can't fold.
    const [path, content] = eventFile(
      decisionEvent(a, "accepted", {
        data: { body_sha256: "0".repeat(64) },
        at: "2099-01-01T00:00:00Z",
      }),
    );
    await r.writeFiles({ [path]: content, "docs/adr/decisions/a7c2m9xd-orphan.md": "# Orphan\n" });
    const out = runAdr(r, ["list"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`-  ${a}  accepted  Use DynamoDB for orders\n`);
    expect(out.stderr).toBe(
      [
        "adr: warning: numbers are unavailable (no main branch); decisions display by id",
        "adr: warning: the decision log has 1 problem; run adr verify",
        "adr: warning: 1 decision can't be read; run adr verify",
        "",
      ].join("\n"),
    );
    expect(JSON.parse(runAdr(r, ["list", "--json"]).stdout)).toMatchObject({
      numbering: { available: false, reason: "no-main-ref", ref: null },
      unfoldable: ["a7c2m9xd"],
      notes: [],
    });
  });

  it("refuses positional arguments", async () => {
    const r = await repo();
    const out = runAdr(r, ["list", "extra"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(
      'adr: error: unexpected argument "extra"; usage: adr list [--status <status>]…\n',
    );
  });
});
