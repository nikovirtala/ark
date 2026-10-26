import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog } from "../log.js";
import {
  cliRepo,
  REPO_HUMAN,
  runAdr,
  seedDecision,
  seedSupersession,
} from "../test-support/cli.js";
import { cliEnv } from "../test-support/decision-arbs.js";
import { decisionEvent, eventFile } from "../test-support/events.js";
import { acceptDecision } from "../write.js";

const run = promisify(execFile);

import { cloneRepo, INDEX, INDEX_CONFIG, shallowClone } from "../test-support/index-repo.js";

const repos: TempRepo[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
  for (const c of cleanups.splice(0)) await c();
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
      "since",
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
      since: null,
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
      'adr: error: unexpected argument "extra"; usage: adr list [--status <status>]… [--since <rev>]\n',
    );
  });
});

// Design 2b D1, §4.6: shallow clones read the numbers recorded in the committed index.md.
describe("adr list in a shallow clone", { timeout: 60_000 }, () => {
  /** Three accepted decisions and one proposed one, with a committed index (binding item 5). */
  async function fixture(config = INDEX_CONFIG) {
    const r = await repo({ "docs/adr/adr.toml": config });
    const ids = [
      await seedDecision(r, "Use DynamoDB"),
      await seedDecision(r, "Use Aurora"),
      await seedDecision(r, "Use Redis"),
    ];
    const proposed = await seedDecision(r, "Use Kafka", { accept: false });
    return { r, ids, proposed };
  }
  async function clone(r: TempRepo) {
    const c = await shallowClone(r);
    cleanups.push(c.dispose);
    return (args: string[]) => runAdr(r, args, { cwd: c.root });
  }
  type ListDoc = {
    numbering: { available: boolean; reason: string | null };
    decisions: { id: string; number: number | null }[];
  };
  const numbers = (stdout: string) =>
    Object.fromEntries((JSON.parse(stdout) as ListDoc).decisions.map((v) => [v.id, v.number]));
  const INDEX_NOTE = `adr: warning: numbers come from ${INDEX} (shallow clone)\n`;

  it("shows the numbers the committed index recorded, with a note", async () => {
    const { r, ids, proposed } = await fixture();
    const adr = await clone(r);
    const out = adr(["list"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe(INDEX_NOTE);
    expect(
      out.stdout
        .split("\n")
        .slice(0, 3)
        .map((l) => l.slice(0, 18)),
    ).toEqual(ids.map((id, i) => `ADR-000${i + 1}  ${id}`));
    const doc = JSON.parse(adr(["list", "--json"]).stdout) as ListDoc;
    expect(doc.numbering).toMatchObject({ available: true, reason: "index" });
    expect(numbers(adr(["list", "--json"]).stdout)).toEqual({
      [ids[0] ?? ""]: 1,
      [ids[1] ?? ""]: 2,
      [ids[2] ?? ""]: 3,
      [proposed]: null,
    });
    const show = adr(["show", "ADR-0002", "--json"]);
    expect(show.status).toBe(0);
    expect(JSON.parse(show.stdout).decision.id).toBe(ids[1]);
    expect(show.stderr).toBe(INDEX_NOTE);
    expect(adr(["for", "README.md"]).stderr).toBe(INDEX_NOTE);
  });

  it("doesn't number an acceptance that exists only in the work tree", async () => {
    const { r, ids, proposed } = await fixture();
    const adr = await clone(r);
    const before = numbers(adr(["list", "--json"]).stdout);
    expect(before[proposed]).toBeNull();
    expect(adr(["accept", proposed, "--no-commit"]).status).toBe(0);
    const after = numbers(adr(["list", "--json"]).stdout);
    expect(after).toEqual(before);
    expect(ids.map((id) => after[id])).toEqual([1, 2, 3]);
    expect(numbers(adr(["list", "--ref", "HEAD", "--json"]).stdout)).toEqual(before);
  });

  it("displays ids without a committed index, and names both fixes", async () => {
    const { r, ids, proposed } = await fixture("");
    const adr = await clone(r);
    const out = adr(["list"]);
    expect(out.status).toBe(0);
    // Unnumbered rows sort by proposed_at, then id, and the seeds can share a second.
    const rows = out.stdout.trimEnd().split("\n");
    expect(rows.every((l) => l.startsWith("-  "))).toBe(true);
    expect(rows.map((l) => l.split("  ")[1]).sort()).toEqual([...ids, proposed].sort());
    expect(out.stderr).toBe(
      'adr: warning: numbers are unavailable (shallow clone); run git fetch --unshallow, or commit an index with [log] index = "committed"\n',
    );
  });

  it("doesn't read an index.md when [log] index isn't committed", async () => {
    const { r } = await fixture();
    await r.write("docs/adr/adr.toml", "");
    await r.commit("turn the index off", { all: true });
    const adr = await clone(r);
    const doc = JSON.parse(adr(["list", "--json"]).stdout) as ListDoc;
    expect(doc.numbering).toMatchObject({ available: false, reason: "shallow" });
    expect(doc.decisions.every((v) => v.number === null)).toBe(true);
  });
});

// Design 2b D7: what a pull brought, for the post-merge hook.
describe("adr list --since", { timeout: 60_000 }, () => {
  /** `r` with Aurora proposed, a full clone of it, and Aurora accepted in `r` after the clone. */
  async function pulled() {
    const r = await repo();
    const x = await seedDecision(r, "Use Aurora", { accept: false });
    const y = await seedDecision(r, "Use Redis", { accept: false });
    const c = await cloneRepo(r);
    cleanups.push(c.dispose);
    const before = await head(r);
    await seedDecision(r, "Use Kafka", { accept: false });
    const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
    await acceptDecision(log, { id: x, actor: REPO_HUMAN }, { commit: true });
    const pull = () =>
      run("git", ["-C", c.root, "pull", "-q", "--ff-only"], {
        env: cliEnv(r) as Record<string, string>,
      });
    await pull();
    const adr = (args: string[]) => runAdr(r, args, { cwd: c.root });
    return { r, x, y, before, adr, pull };
  }

  it("lists what a fast-forward pull brought, with the new event types", async () => {
    const { x, before, adr } = await pulled();
    const out = adr(["list", "--since", "ORIG_HEAD"]);
    expect(out.status).toBe(0);
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`Changed since ORIG_HEAD (${before.slice(0, 7)}):`);
    expect(lines.filter((l) => l.startsWith("  [new: "))).toEqual([
      "  [new: accepted]",
      "  [new: proposed]",
    ]);
    expect(lines[1]).toMatch(new RegExp(`^ADR-0001  ${x}  accepted  Use Aurora$`));
    const doc = JSON.parse(adr(["list", "--since", "ORIG_HEAD", "--json"]).stdout);
    expect(doc.since).toMatchObject({ rev: "ORIG_HEAD", commit: before });
    expect(doc.since.events.map((e: { type: string }) => e.type).sort()).toEqual([
      "accepted",
      "proposed",
    ]);
    expect(Object.keys(doc.since.events[0]).sort()).toEqual(["path", "subject", "type"]);
    expect(doc.decisions.map((v: { id: string }) => v.id)[0]).toBe(x);

    const proposed = adr(["list", "--since", "ORIG_HEAD", "--status", "proposed", "--json"]);
    const listed = JSON.parse(proposed.stdout).decisions.map((v: { status: string }) => v.status);
    expect(listed).toEqual(["proposed"]);
  });

  it("prints nothing after a pull without log changes", async () => {
    const { r, adr, pull } = await pulled();
    await r.write("README.md", "changed\n");
    await r.commit("docs: change the readme", { all: true });
    await pull();
    expect(adr(["list", "--since", "ORIG_HEAD"])).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("diffs against --ref when given", async () => {
    const { r, before } = await pulled();
    expect(runAdr(r, ["list", "--ref", before, "--since", before]).stdout).toBe("");
    const doc = JSON.parse(
      runAdr(r, ["list", "--ref", "HEAD~1", "--since", before, "--json"]).stdout,
    );
    expect(doc.since.events.map((e: { type: string }) => e.type)).toEqual(["proposed"]);
    expect(doc.decisions.map((v: { status: string }) => v.status)).toEqual(["proposed"]);
  });

  it("exits 2 for a revision that is missing or isn't one", async () => {
    const r = await repo();
    for (const [args, message] of [
      [["list", "--since", "nope"], "ref not found: nope"],
      [["list", "--since="], "--since must be a revision"],
      [["list", "--since=-x"], "--since must be a revision"],
    ] as const) {
      const out = runAdr(r, [...args]);
      expect(out.status, args.join(" ")).toBe(2);
      expect(out.stderr).toBe(`adr: error: ${message}\n`);
    }
    expect(runAdr(r, ["list", "--since", "-x"]).status).toBe(2);
  });
});

const SOURCES =
  '[[sources]]\nname = "platform"\nkind = "adr"\nurl = "https://example.com/p.git"\nref = "main"\n';
const SOURCES_NOTE =
  "adr: warning: only this repository's decision log is read; the logs in [[sources]] (platform) aren't listed or searched until ark's step 4\n";

describe("adr list with [[sources]]", () => {
  it("notes that only the local log is read", async () => {
    const r = await repo({ "adr.toml": SOURCES });
    const out = runAdr(r, ["list"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe(SOURCES_NOTE);
    expect(JSON.parse(runAdr(r, ["list", "--json"]).stdout).notes).toEqual([
      SOURCES_NOTE.slice(14, -1),
    ]);
  });
});
