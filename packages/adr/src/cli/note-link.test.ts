import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliRepo,
  runAdr,
  seedDecision,
  seedSupersession,
  WRITE_KEYS,
} from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

type View = { id: string; status: string; notes: number; links: { to: string; rel: string }[] };
type WriteDoc = {
  format: string;
  command: string;
  ok: boolean;
  decision: View | null;
  written: string[];
  commit: string | null;
  notes: string[];
};
function doc(stdout: string): WriteDoc {
  const d = JSON.parse(stdout) as WriteDoc;
  expect(d.format).toBe("adr-write/v1");
  expect(Object.keys(d).sort()).toEqual(WRITE_KEYS);
  return d;
}

function usageError(r: TempRepo, args: string[], message: string): void {
  const out = runAdr(r, ["--json", ...args]);
  expect(out.status, args.join(" ")).toBe(2);
  expect(JSON.parse(out.stdout)).toEqual({
    format: "ark-error/v1",
    error: { code: "usage", message },
  });
  expect(out.stderr).toBe(`adr: error: ${message}\n`);
}

// 01:138–139, 01:169, design §6.6.
describe("adr note", { timeout: 90_000 }, () => {
  it("notes a decision in every state, terminal ones included", async () => {
    const r = await repo();
    const proposed = await seedDecision(r, "Proposed one", { accept: false });
    const accepted = await seedDecision(r, "Accepted one");
    const rejected = await seedDecision(r, "Rejected one", { accept: false });
    const withdrawn = await seedDecision(r, "Withdrawn one", { accept: false });
    const deprecated = await seedDecision(r, "Deprecated one");
    const superseded = await seedDecision(r, "Superseded one");
    expect(runAdr(r, ["reject", rejected, "--reason", "No", "--commit"]).status).toBe(0);
    expect(runAdr(r, ["withdraw", withdrawn, "--commit"]).status).toBe(0);
    expect(runAdr(r, ["deprecate", deprecated, "--reason", "Old", "--commit"]).status).toBe(0);
    await seedSupersession(r, superseded, accepted);
    const states: [string, string][] = [
      [proposed, "proposed"],
      [accepted, "accepted"],
      [rejected, "rejected"],
      [withdrawn, "withdrawn"],
      [deprecated, "deprecated"],
      [superseded, "superseded"],
    ];
    for (const [id, status] of states) {
      const out = runAdr(r, ["note", id, "Benchmarks are in the wiki.\nSee page 2.", "--json"]);
      expect(out.status, status).toBe(0);
      expect(doc(out.stdout)).toMatchObject({
        command: "note",
        ok: true,
        decision: { id, status, notes: 1 },
      });
    }
  });

  it("writes the text as given, and commits with a conventional subject", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Build ledger as the shared core for event-sourced records");
    const out = runAdr(r, ["note", "ADR-0001", "Line one\n\nLine two", "--commit"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      `Noted on ADR-0001 (${a}): Build ledger as the shared core for event-sourced records\nCommitted ${(await git(r, "rev-parse", "--short=7", "HEAD")).trim()}.\n`,
    );
    expect(await git(r, "log", "-1", "--format=%B")).toBe(
      `docs(adr): add a note to ADR-0001\n\nADR: ${a}\nADR-Event: noted\n\n`,
    );
    const event = (await git(r, "show", "--name-only", "--format=", "HEAD")).trim();
    expect(await git(r, "show", `HEAD:${event}`)).toContain(
      "text: |-\n    Line one\n\n    Line two\n",
    );
  });

  it("exits 2 for blank text and a missing argument", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora");
    usageError(r, ["note", a, " \n "], "the note text must not be empty");
    usageError(
      r,
      ["note", a],
      "missing argument <text>; usage: adr note <decision> <text> [--commit | --no-commit] [-m <message>]",
    );
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});

// 01:139, 01:169, ADR-0005, design §6.7.
describe("adr link", { timeout: 90_000 }, () => {
  it("links two decisions, and commits with the target in the body", async () => {
    const r = await repo();
    // A title ending in "." gets one period in the body sentence.
    const a = await seedDecision(r, "Use one shared event envelope, ledger/v1, for every kind.");
    const b = await seedDecision(r, "Use Aurora");
    const out = runAdr(r, ["link", b, "ADR-0001", "--rel", "depends-on", "--commit", "--json"]);
    expect(out.status).toBe(0);
    expect(doc(out.stdout)).toMatchObject({
      command: "link",
      ok: true,
      decision: { id: b, links: [{ to: a, rel: "depends-on" }] },
    });
    expect(await git(r, "log", "-1", "--format=%B")).toBe(
      [
        "docs(adr): link ADR-0002 to ADR-0001",
        "",
        "depends-on ADR-0001: Use one shared event envelope, ledger/v1, for every",
        "kind.",
        "",
        `ADR: ${b}`,
        "ADR-Event: linked",
        "",
        "",
      ].join("\n"),
    );
    const text = runAdr(r, ["link", a, b]);
    expect(text.status).toBe(0);
    expect(text.stdout).toBe(
      `Linked ADR-0001 (${a}) relates-to ADR-0002 (${b})\nStaged; commit to record it.\n`,
    );
  });

  it("writes nothing for a link that exists, with a note", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB");
    const b = await seedDecision(r, "Use Aurora");
    expect(runAdr(r, ["link", b, a, "--commit"]).status).toBe(0);
    const head = await git(r, "rev-parse", "HEAD");
    const out = runAdr(r, ["link", b, "1", "--commit", "--json"]);
    expect(out.status).toBe(0);
    const note = "already linked: ADR-0002 relates-to ADR-0001; nothing written";
    expect(doc(out.stdout)).toMatchObject({ ok: true, written: [], commit: null, notes: [note] });
    expect(out.stderr).toBe(`adr: warning: ${note}\n`);
    expect(runAdr(r, ["link", b, a]).stdout).toBe(`Links of ADR-0002 (${b}) unchanged\n`);
    expect(await git(r, "rev-parse", "HEAD")).toBe(head);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("links to a decision in a configured source without looking it up", async () => {
    const r = await repo({
      "docs/adr/adr.toml":
        '[[sources]]\nname = "platform"\nkind = "decision"\nurl = "https://example.com/platform.git"\nref = "main"\n',
    });
    const a = await seedDecision(r, "Use Aurora");
    const out = runAdr(r, [
      "link",
      a,
      "platform:k3f9q8a1",
      "--rel",
      "refines",
      "--commit",
      "--json",
    ]);
    expect(out.status).toBe(0);
    expect(doc(out.stdout).decision?.links).toEqual([{ to: "platform:k3f9q8a1", rel: "refines" }]);
    expect(await git(r, "log", "-1", "--format=%s")).toBe(
      "docs(adr): link ADR-0001 to a decision in another log\n",
    );
    expect(await git(r, "log", "-1", "--format=%b")).toBe(
      `refines platform:k3f9q8a1.\n\nADR: ${a}\nADR-Event: linked\n\n`,
    );
    expect(runAdr(r, ["verify"]).status).toBe(0);
  });

  it("never shortens a link subject's names under a [commit] subject that fits them", async () => {
    const r = await repo({
      "docs/adr/adr.toml": `[commit]\nsubject = "docs(adr): ${"x".repeat(29)} {title}"\n[[sources]]\nname = "platform"\nkind = "decision"\nurl = "https://example.com/platform.git"\nref = "main"\n`,
    });
    const a = await seedDecision(r, "Use Aurora");
    const out = runAdr(r, ["link", a, "platform:k3f9q8a1", "--commit", "--json"]);
    expect(out.status).toBe(0);
    expect(await git(r, "log", "-1", "--format=%s")).toBe(
      `docs(adr): ${"x".repeat(29)} ADR-0001 to a decision in another log\n`,
    );
    expect(await git(r, "log", "-1", "--format=%b")).not.toContain("Full title:");
    expect(doc(out.stdout).notes).toEqual([]);
  });

  it("exits 2 for a self link, an unknown rel and an unknown source", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora");
    usageError(r, ["link", a, a], "a decision can't link to itself");
    usageError(r, ["link", a, "ADR-0001"], "a decision can't link to itself");
    usageError(
      r,
      ["link", a, "ADR-0001", "--rel", "blocks"],
      "unknown --rel blocks; use relates-to, refines or depends-on",
    );
    usageError(
      r,
      ["link", a, "platform:k3f9q8a1"],
      "unknown source platform; add a [[sources]] entry named platform",
    );
    usageError(r, ["link", a, "ADR-0042"], "unknown decision ADR-0042");
    expect(await git(r, "status", "--porcelain")).toBe("");
  });
});
