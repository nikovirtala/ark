import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr, seedDecision, seedSupersession } from "../test-support/cli.js";
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

async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout)
    .toString("utf8")
    .trim();
}
type Found = { severity: string; rule: string; message: string; file: string; subject: string };
/** `adr verify --json` with `args`: its exit and the findings, without their line numbers. */
function verifyJson(r: TempRepo, args: string[] = []): { status: number | null; found: Found[] } {
  const out = runAdr(r, ["verify", "--json", ...args]);
  const doc = JSON.parse(out.stdout) as { findings: Found[] };
  return {
    status: out.status,
    found: doc.findings.map(({ severity, rule, message, file, subject }) => ({
      severity,
      rule,
      message,
      file,
      subject,
    })),
  };
}
const SOURCES = { "src/a.ts": "export {};\n", "src/b.ts": "export {};\n" };

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

// 01:362–367, design 2b §4.8: the checks over code.
describe("adr verify over code", { timeout: 90_000 }, () => {
  it("warns about a change governed by a superseded or deprecated decision", async () => {
    const r = await repo(SOURCES);
    const a = await seedDecision(r, "Use DynamoDB for orders");
    expect(runAdr(r, ["scope", a, "--set", "src/a.ts", "--commit"]).status).toBe(0);
    const b = await seedDecision(r, "Use Aurora for orders");
    await seedSupersession(r, a, b);
    const c = await seedDecision(r, "Use Redis for sessions");
    expect(runAdr(r, ["scope", c, "--set", "src/b.ts", "--commit"]).status).toBe(0);
    expect(runAdr(r, ["deprecate", c, "--reason", "Old.", "--commit"]).status).toBe(0);
    const base = await git(r, "rev-parse", "HEAD");
    await r.writeFiles({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    await r.commit("change both", { all: true });

    const warnings = [
      {
        severity: "warning",
        rule: "decision/governed-by-inactive",
        message:
          "src/a.ts is governed by ADR-0001, which is superseded by ADR-0002; check the change against ADR-0002",
        file: "src/a.ts",
        subject: a,
      },
      {
        severity: "warning",
        rule: "decision/governed-by-inactive",
        message:
          "src/b.ts is governed by ADR-0003, which is deprecated; check whether the change still needs it",
        file: "src/b.ts",
        subject: c,
      },
    ];
    expect(verifyJson(r, ["--base", base])).toEqual({ status: 0, found: warnings });
    // Full mode has no base to compare with, so it says nothing.
    expect(verifyJson(r)).toEqual({ status: 0, found: [] });

    await r.write("docs/adr/adr.toml", '[verify]\nfail_on = "warning"\n');
    expect(verifyJson(r, ["--base", base])).toEqual({ status: 1, found: warnings });
    await r.write("docs/adr/adr.toml", '[verify]\ngoverned_by_inactive = "error"\n');
    expect(verifyJson(r, ["--base", base])).toEqual({
      status: 1,
      found: warnings.map((w) => ({ ...w, severity: "error" })),
    });
    await r.write("docs/adr/adr.toml", '[verify]\ngoverned_by_inactive = "never"\n');
    const bad = runAdr(r, ["verify", "--base", base]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toBe(
      'adr: error: docs/adr/adr.toml: verify.governed_by_inactive must be "warning" or "error"\n',
    );
  });

  it("warns when an accepted scope narrows, but not when it follows a move", async () => {
    const r = await repo({ ...SOURCES, "src/c.ts": "x\n", "src/d.ts": "x\n", "src/e.ts": "x\n" });
    const a = await seedDecision(r, "Use DynamoDB for orders");
    expect(runAdr(r, ["scope", a, "--set", "src/**", "--commit"]).status).toBe(0);
    const base = await git(r, "rev-parse", "HEAD");
    expect(
      runAdr(r, ["scope", a, "--set", "src/a.ts", "--set", "src/e.ts", "--commit"]).status,
    ).toBe(0);
    const event = await git(r, "show", "--name-only", "--format=", "HEAD");
    expect(verifyJson(r, ["--base", base])).toEqual({
      status: 0,
      found: [
        {
          severity: "warning",
          rule: "decision/scope-narrowed",
          message:
            "ADR-0001's scope no longer covers 3 files that still exist (src/b.ts, src/c.ts, src/d.ts); check the change against its Scope section",
          file: event,
          subject: a,
        },
      ],
    });
    expect(runAdr(r, ["scope", a, "--remove", "src/e.ts", "--commit"]).status).toBe(0);
    expect(verifyJson(r, ["--base", base]).found.map((f) => f.message)).toEqual([
      "ADR-0001's scope no longer covers 4 files that still exist (src/b.ts, src/c.ts, src/d.ts, …); check the change against its Scope section",
    ]);

    const moved = await repo({ "src/orders/api.ts": "export {};\n" });
    const m = await seedDecision(moved, "Use Aurora for orders");
    expect(runAdr(moved, ["scope", m, "--set", "src/orders/**", "--commit"]).status).toBe(0);
    const before = await git(moved, "rev-parse", "HEAD");
    await git(moved, "mv", "src/orders", "src/billing");
    expect(runAdr(moved, ["scope", "--follow-renames"]).status).toBe(0);
    await moved.commit("refactor: move orders to billing");
    expect(verifyJson(moved, ["--base", before])).toEqual({ status: 0, found: [] });
  });

  it("fails on a glob that no longer matches, but not for a deprecated decision", async () => {
    const r = await repo({ "src/orders/api.ts": "export {};\n", "src/b.ts": "x\n" });
    const a = await seedDecision(r, "Use DynamoDB for orders");
    expect(runAdr(r, ["scope", a, "--set", "src/orders/**", "--commit"]).status).toBe(0);
    const event = await git(r, "show", "--name-only", "--format=", "HEAD");
    expect(verifyJson(r)).toEqual({ status: 0, found: [] });
    await git(r, "rm", "-q", "src/orders/api.ts");
    await r.commit("remove orders");
    const unmatched = {
      severity: "error",
      rule: "scope/glob-unmatched",
      message: 'scope glob "src/orders/**" matches no tracked file',
      file: event,
      subject: a,
    };
    expect(verifyJson(r)).toEqual({ status: 1, found: [unmatched] });
    expect(verifyJson(r, ["--ref", "HEAD"])).toEqual({ status: 1, found: [unmatched] });
    expect(runAdr(r, ["deprecate", a, "--reason", "Orders are gone.", "--commit"]).status).toBe(0);
    expect(verifyJson(r)).toEqual({ status: 0, found: [] });
  });

  it("fails on an invalid glob in a hand-written scoped event", async () => {
    const r = await repo(SOURCES);
    const a = await seedDecision(r, "Use DynamoDB for orders");
    const [path, content] = eventFile(
      decisionEvent(a, "scoped", { data: { set: ["{a,{b}}"] }, at: "2099-01-01T00:00:00Z" }),
    );
    await r.write(path, content);
    const out = verifyJson(r);
    expect(out.status).toBe(1);
    expect(out.found).toEqual([
      expect.objectContaining({ rule: "scope/glob-invalid", file: path, subject: a }),
    ]);
    expect(out.found[0]?.message).toMatch(/^scope glob "\{a,\{b\}\}" is invalid: /);
  });

  it("fails on an anchor that names no decision, and accepts one that does", async () => {
    const r = await repo(SOURCES);
    const a = await seedDecision(r, "Use DynamoDB for orders");
    await r.write("src/x.ts", "// adr:aaaaaaaa\n");
    expect(verifyJson(r)).toEqual({
      status: 1,
      found: [
        {
          severity: "error",
          rule: "scope/anchor-missing",
          message: "anchor adr:aaaaaaaa names no decision in this log",
          file: "src/x.ts",
          subject: "aaaaaaaa",
        },
      ],
    });
    await r.write("src/x.ts", `// adr:${a}\n`);
    expect(verifyJson(r)).toEqual({ status: 0, found: [] });
  });
});
