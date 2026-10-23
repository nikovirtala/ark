import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr, seedDecision, seedSupersession } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await cliRepo();
  repos.push(r);
  return r;
}
const head = async (r: TempRepo) =>
  Buffer.from((await r.git.run(["rev-parse", "HEAD"])).stdout)
    .toString("utf8")
    .trim();
const today = () => new Date().toISOString().slice(0, 10);

/** A (ADR-0001) superseded by B (ADR-0002); `before` is the commit before the supersession. */
async function superseded(r: TempRepo) {
  const a = await seedDecision(r, "Use DynamoDB for orders");
  const b = await seedDecision(r, "Use Aurora for orders");
  const before = await head(r);
  await seedSupersession(r, a, b);
  return { a, b, before };
}

describe("adr show", { timeout: 60_000 }, () => {
  it("leads with the state header, then the fields and the body", async () => {
    const r = await repo();
    const { a, b } = await superseded(r);
    const d = today();
    const out = runAdr(r, ["show", "ADR-0001"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    const lines = out.stdout.split("\n");
    expect(lines.slice(0, 12)).toEqual([
      `ADR-0001 (${a}) · superseded`,
      `SUPERSEDED by ADR-0002 (accepted ${d}). Do not apply this decision; read ADR-0002 instead.`,
      "",
      "Title:      Use DynamoDB for orders",
      `Status:     superseded (${d})`,
      `Effective:  ADR-0002 (${b})`,
      "Chain:      ADR-0001 → ADR-0002",
      "Supersedes: none",
      "Applies to: no globs recorded",
      `Body:       docs/adr/decisions/${a}-use-dynamodb-for-orders.md (intact)`,
      `History:    proposed ${d} · accepted ${d} · superseded ${d}`,
      "",
    ]);
    expect(lines[12]).toBe("# Use DynamoDB for orders");
    expect(out.stdout).toContain("## Scope\nservices/orders\n");
  });

  it("says when no globs are recorded, and how to add them while it can take them", async () => {
    const r = await repo();
    const p = await seedDecision(r, "Use Aurora for orders", { accept: false });
    const proposed = runAdr(r, ["show", p]);
    expect(proposed.status).toBe(0);
    expect(proposed.stdout).toContain(
      `Applies to: no globs recorded; add them with adr scope ${p} --add <glob>\n`,
    );
    expect(JSON.parse(runAdr(r, ["show", p, "--json"]).stdout).decision.applies_to).toEqual([]);
    const accepted = await seedDecision(r, "Use DynamoDB for orders");
    expect(runAdr(r, ["show", accepted]).stdout).toContain(
      "Applies to: no globs recorded; add them with adr scope ADR-0001 --add <glob>\n",
    );
    expect(runAdr(r, ["reject", p, "--reason", "Too early", "--commit"]).status).toBe(0);
    const rejected = runAdr(r, ["show", p]);
    expect(rejected.stdout).toContain("Applies to: no globs recorded\n");
    expect(JSON.parse(runAdr(r, ["show", p, "--json"]).stdout).decision.applies_to).toEqual([]);
  });

  it("takes an id or a number in any form", async () => {
    const r = await repo();
    const { a } = await superseded(r);
    const expected = runAdr(r, ["show", "ADR-0001"]).stdout;
    for (const input of [a, "1", "0001", "ADR-1", "adr-0001"]) {
      expect(runAdr(r, ["show", input]).stdout).toBe(expected);
    }
  });

  it("prints the adr-show/v1 document with --json", async () => {
    const r = await repo();
    const { a, b } = await superseded(r);
    const out = runAdr(r, ["show", "ADR-0002", "--json"]);
    expect(out.status).toBe(0);
    const doc = JSON.parse(out.stdout);
    expect(Object.keys(doc)).toEqual([
      "format",
      "root",
      "ref",
      "commit",
      "numbering",
      "header",
      "decision",
      "body",
      "events",
      "findings",
      "notes",
    ]);
    expect(doc).toMatchObject({
      format: "adr-show/v1",
      root: "docs/adr",
      ref: null,
      commit: await head(r),
      numbering: { available: true, reason: null, ref: "refs/heads/main" },
      header: { line: `ADR-0002 (${b}) · accepted`, warning: null },
      decision: { id: b, number: 2, status: "accepted", supersedes: [a], body_intact: true },
      events: null,
      findings: [],
      notes: [],
    });
    expect(doc.body).toMatch(/^# Use Aurora for orders\n/);
  });

  it("lists every event with --history", async () => {
    const r = await repo();
    const { a, b } = await superseded(r);
    const out = runAdr(r, ["show", a, "--history"]);
    expect(out.status).toBe(0);
    const history = out.stdout.split("\n").filter((l) => l.startsWith("  "));
    expect(history).toHaveLength(6);
    expect(history[0]).toMatch(/^ {2}\S+Z {2}proposed {4}Ledger Test$/);
    expect(history[1]).toBe(
      "    title: Use DynamoDB for orders, template: nygard, template_version: 1",
    );
    expect(history[2]).toMatch(/^ {2}\S+Z {2}accepted {4}Ledger Test$/);
    expect(history[3]).toMatch(/^ {4}body_sha256: [0-9a-f]{64}$/);
    expect(history[4]).toMatch(/^ {2}\S+Z {2}superseded {2}Ledger Test$/);
    expect(history[5]).toBe(`    by: ${b}`);
    expect(out.stdout).not.toContain("History:    ");

    const doc = JSON.parse(runAdr(r, ["show", a, "--history", "--json"]).stdout);
    expect(doc.events.map((e: { type: string }) => e.type)).toEqual([
      "proposed",
      "accepted",
      "superseded",
    ]);
  });

  it("shows the decision as of --ref", async () => {
    const r = await repo();
    const { a, before } = await superseded(r);
    const out = runAdr(r, ["show", "ADR-0001", "--ref", before]);
    expect(out.status).toBe(0);
    expect(out.stdout.split("\n").slice(0, 2)).toEqual([`ADR-0001 (${a}) · accepted`, ""]);
  });

  it("exits 2 for an unknown decision or a missing argument", async () => {
    const r = await repo();
    await superseded(r);
    expect(runAdr(r, ["show", "ADR-0042"])).toEqual({
      status: 2,
      stdout: "",
      stderr: "adr: error: unknown decision ADR-0042\n",
    });
    const json = runAdr(r, ["--json", "show", "ADR-0042"]);
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "usage", message: "unknown decision ADR-0042" },
    });
    const missing = runAdr(r, ["show"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toBe(
      "adr: error: missing argument <decision>; usage: adr show <decision> [--history]\n",
    );
  });
});
