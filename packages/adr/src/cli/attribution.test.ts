import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEventYaml } from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, NYGARD_SECTIONS, runAdr, seedDecision } from "../test-support/cli.js";

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

const FULL = Object.entries(NYGARD_SECTIONS).flatMap(([k, v]) => ["--section", `${k}=${v}`]);
const FROM_GIT =
  "on_behalf_of taken from the git identity ledger-test@example.com; set ARK_ON_BEHALF_OF to name who you act for";
const IGNORED =
  "ARK_ON_BEHALF_OF is ignored without ARK_AGENT; events are recorded as Ledger Test <ledger-test@example.com>";

type WriteDoc = { ok: boolean; written: string[]; notes: string[] };

/** The actor of the event file a write reported. */
async function actorOf(r: TempRepo, doc: WriteDoc): Promise<unknown> {
  const path = doc.written.find((p) => p.endsWith(".yaml")) ?? "";
  const parsed = parseEventYaml(await readFile(join(r.root, path)), { file: path });
  if (!parsed.ok) throw new Error(`${path} doesn't parse`);
  return (parsed.doc as { actor: unknown }).actor;
}

// dec:27–32, design §5.2–5.3: every event write reports how its actor was decided.
describe("attribution of adr writes", { timeout: 60_000 }, () => {
  it("notes an agent acting for the git identity, on stderr and in the JSON notes", async () => {
    const r = await repo();
    const env = { ARK_AGENT: "kiro" };
    const out = runAdr(r, ["new", "Use Aurora", ...FULL, "--json"], { env });
    expect(out.status).toBe(0);
    const doc = JSON.parse(out.stdout) as WriteDoc;
    expect(doc.notes).toEqual([FROM_GIT]);
    expect(out.stderr).toBe(`adr: warning: ${FROM_GIT}\n`);
    expect(await actorOf(r, doc)).toEqual({
      kind: "agent",
      name: "kiro",
      email: null,
      agent: "kiro",
      on_behalf_of: "ledger-test@example.com",
    });

    const a = await seedDecision(r, "Use DynamoDB");
    const b = await seedDecision(r, "Use Postgres");
    const superseded = runAdr(r, ["supersede", a, "--by", b], { env });
    expect(superseded.status).toBe(0);
    expect(superseded.stderr).toBe(`adr: warning: ${FROM_GIT}\n`);
    const c = await seedDecision(r, "Use SQLite", { accept: false });
    const refused = runAdr(r, ["accept", c, "--json"], { env });
    expect(refused.status).toBe(1);
    expect((JSON.parse(refused.stdout) as WriteDoc).notes).toEqual([FROM_GIT]);
  });

  it("records ARK_ON_BEHALF_OF without a note", async () => {
    const r = await repo();
    const env = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: " niko@example.org " };
    const out = runAdr(r, ["new", "Use Aurora", ...FULL, "--json"], { env });
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    const doc = JSON.parse(out.stdout) as WriteDoc;
    expect(doc.notes).toEqual([]);
    expect(await actorOf(r, doc)).toMatchObject({
      kind: "agent",
      on_behalf_of: "niko@example.org",
    });
  });

  it("notes an ignored ARK_ON_BEHALF_OF without ARK_AGENT", async () => {
    const r = await repo();
    const out = runAdr(r, ["new", "Use Aurora", ...FULL, "--json"], {
      env: { ARK_ON_BEHALF_OF: "niko@example.org" },
    });
    expect(out.status).toBe(0);
    const doc = JSON.parse(out.stdout) as WriteDoc;
    expect(doc.notes).toEqual([IGNORED]);
    expect(out.stderr).toBe(`adr: warning: ${IGNORED}\n`);
    expect(await actorOf(r, doc)).toMatchObject({ kind: "human", on_behalf_of: null });
  });

  it("exits 2 for an address that isn't an email, writing nothing", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use DynamoDB", { accept: false });
    const before = await git(r, "status", "--porcelain");
    for (const env of [
      { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "niko" },
      { ARK_ON_BEHALF_OF: "niko" },
    ]) {
      for (const args of [
        ["new", "Use Aurora", ...FULL],
        ["accept", a],
      ]) {
        const out = runAdr(r, ["--json", ...args], { env });
        expect(out.status, args.join(" ")).toBe(2);
        expect(JSON.parse(out.stdout)).toEqual({
          format: "ark-error/v1",
          error: { code: "config", message: 'ARK_ON_BEHALF_OF "niko" is not an email address' },
        });
        expect(out.stderr).toBe('adr: error: ARK_ON_BEHALF_OF "niko" is not an email address\n');
      }
    }
    expect(await git(r, "status", "--porcelain")).toBe(before);
  });
});
