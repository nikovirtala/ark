import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runAdr, seedDecision, WRITE_KEYS } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await cliRepo();
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
const head = async (r: TempRepo) => (await git(r, "rev-parse", "HEAD")).trim();

type WriteDoc = {
  format: string;
  command: string;
  ok: boolean;
  decision: { id: string; status: string } | null;
  written: string[];
  commit: string | null;
  findings: { rule: string; message: string }[];
};
function doc(stdout: string): WriteDoc {
  const d = JSON.parse(stdout) as WriteDoc;
  expect(d.format).toBe("adr-write/v1");
  expect(Object.keys(d).sort()).toEqual(WRITE_KEYS);
  return d;
}

/** Exit 2 with exactly `message` on stderr, and the same in an `ark-error/v1` document. */
function usageError(r: TempRepo, args: string[], message: string): void {
  const out = runAdr(r, args);
  expect(out.status, args.join(" ")).toBe(2);
  expect(out.stdout).toBe("");
  expect(out.stderr).toBe(`adr: error: ${message}\n`);
  const json = runAdr(r, ["--json", ...args]);
  expect(json.status).toBe(2);
  expect(JSON.parse(json.stdout)).toEqual({
    format: "ark-error/v1",
    error: { code: "usage", message },
  });
}

// 01:134–136, design §6.3–6.5 and the §16.4 rows for reject, withdraw and deprecate.
describe("adr reject", { timeout: 60_000 }, () => {
  it("rejects a proposal with a reason, and commits it with the reason in the body", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Adopt GraphQL federation for the public API.", {
      accept: false,
    });
    const out = runAdr(r, ["reject", a, "--reason", "Too early"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      `Rejected ${a}: Adopt GraphQL federation for the public API.\n  reason: Too early\nStaged; commit to record it.\n`,
    );
    await git(r, "reset", "-q");
    await git(r, "clean", "-qfd");

    const committed = runAdr(r, [
      "reject",
      a,
      "--reason",
      "Too early.\n\nRevisit next year.",
      "--commit",
      "--json",
    ]);
    expect(committed.status).toBe(0);
    const d = doc(committed.stdout);
    expect(d).toMatchObject({
      command: "reject",
      ok: true,
      decision: { id: a, status: "rejected" },
    });
    expect(d.commit).toBe(await head(r));
    expect(await git(r, "log", "-1", "--format=%B")).toBe(
      [
        "docs(adr): decide not to adopt GraphQL federation for the public API",
        "",
        "Reason: Too early.",
        "",
        "Revisit next year.",
        "",
        `ADR: ${a}`,
        "ADR-Event: rejected",
        "",
        "",
      ].join("\n"),
    );
  });

  it("exits 1 for an accepted decision, and 2 without a reason", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora");
    const out = runAdr(r, ["reject", a, "--reason", "No", "--json"]);
    expect(out.status).toBe(1);
    expect(doc(out.stdout)).toMatchObject({ ok: false, written: [], commit: null });
    expect(doc(out.stdout).findings).toEqual([
      expect.objectContaining({
        rule: "transition/illegal",
        message: "rejected is not allowed while accepted",
      }),
    ]);
    expect(runAdr(r, ["reject", a, "--reason", "No"]).stdout).toBe(
      `Not rejected: ADR-0001: Use Aurora\n  docs/adr/decisions/${a}-use-aurora.md: rejected is not allowed while accepted [transition/illegal]\n`,
    );
    const usage =
      "missing --reason <text>; usage: adr reject <decision> --reason <text> [--commit | --no-commit] [-m <message>]";
    usageError(r, ["reject", a], usage);
    usageError(r, ["reject", a, "--reason", "  "], usage);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});

describe("adr withdraw", { timeout: 60_000 }, () => {
  it("withdraws a proposal with or without a reason", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Cache order reads", { accept: false });
    const out = runAdr(r, ["withdraw", a, "--commit", "--json"]);
    expect(out.status).toBe(0);
    expect(doc(out.stdout)).toMatchObject({
      command: "withdraw",
      ok: true,
      decision: { id: a, status: "withdrawn" },
    });
    expect(await git(r, "log", "-1", "--format=%B")).toBe(
      `docs(adr): withdraw the proposal to cache order reads\n\nADR: ${a}\nADR-Event: withdrawn\n\n`,
    );
    const b = await seedDecision(r, "Cache order writes", { accept: false });
    const reasoned = runAdr(r, ["withdraw", b, "--reason", "Superseded by a better idea"]);
    expect(reasoned.status).toBe(0);
    expect(reasoned.stdout).toBe(
      `Withdrawn ${b}: Cache order writes\n  reason: Superseded by a better idea\nStaged; commit to record it.\n`,
    );
  });

  it("exits 1 for an accepted decision, and 2 for a blank reason", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora");
    const out = runAdr(r, ["withdraw", a, "--json"]);
    expect(out.status).toBe(1);
    expect(doc(out.stdout).findings.map((f) => f.message)).toEqual([
      "withdrawn is not allowed while accepted",
    ]);
    usageError(r, ["withdraw", a, "--reason", " "], "--reason must not be empty");
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});

describe("adr deprecate", { timeout: 60_000 }, () => {
  it("deprecates an accepted decision", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora");
    const out = runAdr(r, ["deprecate", "ADR-0001", "--reason", "Moving to a managed service"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      `Deprecated ADR-0001 (${a}): Use Aurora\n  reason: Moving to a managed service\nStaged; commit to record it.\n`,
    );
    await git(r, "reset", "-q");
    await git(r, "clean", "-qfd");
    const committed = runAdr(r, ["deprecate", a, "--reason", "Old", "--commit", "--json"]);
    expect(doc(committed.stdout)).toMatchObject({
      command: "deprecate",
      decision: { id: a, status: "deprecated" },
    });
    expect(await git(r, "log", "-1", "--format=%B")).toBe(
      `docs(adr): deprecate ADR-0001\n\nReason: Old\n\nADR: ${a}\nADR-Event: deprecated\n\n`,
    );
  });

  it("exits 1 for a proposal, and 2 without a reason", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora", { accept: false });
    const out = runAdr(r, ["deprecate", a, "--reason", "Old", "--json"]);
    expect(out.status).toBe(1);
    expect(doc(out.stdout).findings.map((f) => f.message)).toEqual([
      "deprecated is not allowed while proposed",
    ]);
    usageError(
      r,
      ["deprecate", a],
      "missing --reason <text>; usage: adr deprecate <decision> --reason <text> [--commit | --no-commit] [-m <message>]",
    );
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});
