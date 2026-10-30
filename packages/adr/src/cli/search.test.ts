import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog, readDecisions } from "../log.js";
import { searchDecisions } from "../search.js";
import {
  cliRepo,
  REPO_HUMAN,
  runAdr,
  seedDecision,
  seedSupersession,
} from "../test-support/cli.js";
import { noteDecision } from "../write.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}
const head = async (r: TempRepo) =>
  Buffer.from((await r.git.run(["rev-parse", "HEAD"])).stdout)
    .toString("utf8")
    .trim();

/** A (DynamoDB) superseded by B (Aurora), both about orders; C proposed, with a note. */
async function seeded(r: TempRepo) {
  const a = await seedDecision(r, "Use DynamoDB for orders");
  const b = await seedDecision(r, "Use Aurora for orders");
  await seedSupersession(r, a, b);
  const c = await seedDecision(r, "Cache session tokens", { accept: false });
  const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
  await noteDecision(
    log,
    { id: c, text: "Tokens expire hourly.", actor: REPO_HUMAN },
    { commit: true },
  );
  return { a, b, c };
}

describe("adr search", { timeout: 60_000 }, () => {
  it("prints active matches with excerpts, and notes the inactive ones", async () => {
    const r = await repo();
    const { b, c } = await seeded(r);
    const out = runAdr(r, ["search", "orders"]);
    expect(out).toEqual({
      status: 0,
      stdout: [
        `ADR-0002 (${b})  accepted  Use Aurora for orders`,
        "  We need a database for orders.",
        `${c}             proposed  Cache session tokens`,
        "  We need a database for orders.",
        '2 decisions match "orders".',
        "",
      ].join("\n"),
      stderr: "adr: warning: 1 inactive decision also matches; add --all to see them\n",
    });
  });

  it("includes inactive decisions with --all, warning under the title", async () => {
    const r = await repo();
    const { a } = await seeded(r);
    const out = runAdr(r, ["search", "dynamodb", "--all"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout.split("\n")).toEqual([
      `ADR-0001 (${a})  superseded  Use DynamoDB for orders`,
      expect.stringMatching(
        /^ {2}SUPERSEDED by ADR-0002 \(accepted \d{4}-\d\d-\d\d\)\. Do not apply/,
      ),
      "  (title match)",
      '1 decision matches "dynamodb".',
      "",
    ]);
  });

  it("shows the heading as the excerpt when only a heading matches", async () => {
    const r = await repo();
    const { b, c } = await seeded(r);
    const out = runAdr(r, ["search", "consequences"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(
      [
        `ADR-0002 (${b})  accepted  Use Aurora for orders`,
        "  ## Consequences",
        `${c}             proposed  Cache session tokens`,
        "  ## Consequences",
        '2 decisions match "consequences".',
        "",
      ].join("\n"),
    );
  });

  it("joins the words, and every one must match", async () => {
    const r = await repo();
    const { c } = await seeded(r);
    const out = runAdr(r, ["search", "tokens", "HOURLY"]);
    expect(out.stdout.split("\n")).toEqual([
      `${c}  proposed  Cache session tokens`,
      "  Tokens expire hourly.",
      '1 decision matches "tokens HOURLY".',
      "",
    ]);
    const none = runAdr(r, ["search", "tokens", "aurora"]);
    expect(none).toEqual({
      status: 0,
      stdout: 'No active decisions match "tokens aurora".\n',
      stderr: "",
    });
    expect(runAdr(r, ["search", "nothing", "--all"]).stdout).toBe(
      'No decisions match "nothing".\n',
    );
  });

  it("prints searchDecisions' document with --json, and reads --ref", async () => {
    const r = await repo();
    await seeded(r);
    const before = await head(r);
    await seedDecision(r, "Shard the orders table");
    const json = runAdr(r, ["search", "orders", "--all", "--json"]);
    expect(json.status).toBe(0);
    const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
    const expected = searchDecisions(await readDecisions(log), {
      query: "orders",
      includeInactive: true,
    });
    expect(JSON.parse(json.stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(expected.total).toBe(4);
    const old = JSON.parse(
      runAdr(r, ["search", "orders", "--all", "--json", "--ref", before]).stdout,
    );
    expect(old).toMatchObject({ ref: before, total: 3 });
  });

  it("exits 2 for a bad query", async () => {
    const r = await repo();
    const long = runAdr(r, ["search", "x".repeat(201)]);
    expect(long.status).toBe(2);
    expect(long.stderr).toContain("the search query must be 1 to 200 characters");
    const many = runAdr(r, ["search", ..."abcdefghijk".split("")]);
    expect(many.status).toBe(2);
    expect(many.stderr).toContain("a search takes at most 10 words");
    expect(runAdr(r, ["search"]).status).toBe(2);
  });

  it("notes that only the local log is read with [[sources]]", async () => {
    const r = await repo({
      "adr.toml":
        '[[sources]]\nname = "platform"\nkind = "adr"\nurl = "https://example.com/p.git"\nref = "main"\n',
    });
    const out = runAdr(r, ["search", "orders"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe(
      "adr: warning: the logs in [[sources]] (platform) are listed with --source <name>, from cached copies; run adr sources fetch to update them\n",
    );
  });
});
