import { type CliIO, runCli } from "@nikovirtala/ledger/cli";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog } from "../log.js";
import { cliRepo, REPO_HUMAN, runAdr, seedDecision, WRITE_KEYS } from "../test-support/cli.js";
import { cliEnv } from "../test-support/decision-arbs.js";
import { acceptDecision, type CopyScope, type ScopeOffer } from "../write.js";
import { adrCli } from "./commands.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

const GLOBS = ["docs/it's.md", "src/orders/**", "src/payments/**"];

/** ADR-0001 scoped to `GLOBS`, and a committed proposal that supersedes it; their ids. */
async function supersedingRepo(): Promise<{ r: TempRepo; old: string; next: string }> {
  const r = await cliRepo({
    "docs/it's.md": "x\n",
    "src/orders/api.ts": "export {}\n",
    "src/payments/pay.ts": "x\n",
  });
  repos.push(r);
  const old = await seedDecision(r, "Use DynamoDB for orders");
  const set = GLOBS.flatMap((g) => ["--set", g]);
  expect(runAdr(r, ["scope", old, ...set, "--commit"]).status).toBe(0);
  const next = await seedDecision(r, "Use Aurora for orders", { accept: false, supersedes: [old] });
  return { r, old, next };
}
const noteFor = (next: string) =>
  `not copying the scope of ADR-0001 (3 globs); to copy it: adr scope ${next} --add 'docs/it'\\''s.md' --add 'src/orders/**' --add 'src/payments/**'`;

type View = { id: string; status: string; applies_to: string[] };
type WriteDoc = {
  format: string;
  ok: boolean;
  decision: View | null;
  affected: View[];
  written: string[];
  commit: string | null;
  findings: { rule: string }[];
  notes: string[];
};
function doc(stdout: string): WriteDoc {
  const d = JSON.parse(stdout) as WriteDoc;
  expect(d.format).toBe("adr-write/v1");
  expect(Object.keys(d).sort()).toEqual(WRITE_KEYS);
  return d;
}

/** Runs `adr` in process with a terminal on stdin and stdout, answering prompts with `answers`. */
async function runAtTerminal(r: TempRepo, args: string[], answers: (string | null)[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    argv: args,
    cwd: r.root,
    // r.env again: its undefined GIT_ENV_ISOLATION keys unset them in the git runCli spawns.
    env: { ...cliEnv(r), ...r.env },
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    interactive: true,
    stdoutIsTTY: true,
    readLine: async () => (answers.length === 0 ? null : (answers.shift() ?? null)),
  };
  const status = await runCli(adrCli("0.0.0"), io);
  return { status, stdout: out.join(""), stderr: err.join("") };
}

// 01:148, design §6.10 (D-e) and the §16.4 accept row.
describe("adr accept --copy-scope", { timeout: 120_000 }, () => {
  it("copies the superseded scope in the same commit with --copy-scope", async () => {
    const { r, old, next } = await supersedingRepo();
    const out = runAdr(r, ["accept", next, "--copy-scope", "--commit"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    const sha = (await git(r, "rev-parse", "--short=7", "HEAD")).trim();
    expect(out.stdout).toBe(
      [
        `Accepted ${next}: Use Aurora for orders`,
        `Superseded ADR-0001 (${old}): Use DynamoDB for orders`,
        `Copied scope from ADR-0001: ${GLOBS.join(", ")}`,
        `Committed ${sha} as ADR-0002.`,
        "",
      ].join("\n"),
    );
    const body = await git(r, "log", "-1", "--format=%B");
    expect(body).toMatch(
      /^docs\(adr\): decide to use Aurora for orders\n\nSupersedes ADR-0001: Use DynamoDB for orders\.\n\nCopies the scope of ADR-0001\.\n\n/,
    );
    expect(await git(r, "log", "-1", "--format=%(trailers:key=ADR-Event,valueonly)")).toBe(
      "accepted\nscoped\nsuperseded\n\n",
    );
    const shown = JSON.parse(runAdr(r, ["show", next, "--json"]).stdout);
    expect(shown.decision.applies_to).toEqual(GLOBS);
    expect(runAdr(r, ["verify"]).status).toBe(0);
  });

  it("doesn't copy with --no-copy-scope, and says nothing", async () => {
    const { r, next } = await supersedingRepo();
    const out = runAdr(r, ["accept", next, "--no-copy-scope", "--json"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe("");
    const d = doc(out.stdout);
    expect(d).toMatchObject({ ok: true, notes: [] });
    expect(d.decision?.applies_to).toEqual([]);
  });

  it("suggests the adr scope command without a terminal and under --json", async () => {
    const { r, next } = await supersedingRepo();
    const out = runAdr(r, ["accept", next]);
    expect(out.status).toBe(0);
    expect(out.stderr).toBe(`adr: warning: ${noteFor(next)}\n`);
    expect(out.stdout).not.toContain("Copied");
    await git(r, "reset", "-q");
    await git(r, "clean", "-qfd");
    const json = runAdr(r, ["accept", next, "--json"]);
    expect(doc(json.stdout)).toMatchObject({ ok: true, notes: [noteFor(next)] });
    expect(doc(json.stdout).decision?.applies_to).toEqual([]);
  });

  it("asks at a terminal: y copies, n and end of input suggest", async () => {
    const { r, next } = await supersedingRepo();
    const q = `Copy the scope of ADR-0001 (${GLOBS.join(", ")}) to ${next}? [y/N] `;
    const no = await runAtTerminal(r, ["accept", next], ["n"]);
    expect(no.status).toBe(0);
    expect(no.stderr).toBe(`${q}adr: warning: ${noteFor(next)}\n`);
    await git(r, "reset", "-q");
    await git(r, "clean", "-qfd");
    const eof = await runAtTerminal(r, ["accept", next], []);
    expect(eof.stderr).toBe(`${q}adr: warning: ${noteFor(next)}\n`);
    await git(r, "reset", "-q");
    await git(r, "clean", "-qfd");
    const json = await runAtTerminal(r, ["--json", "accept", next], ["y"]);
    expect(doc(json.stdout).notes).toEqual([noteFor(next)]);
    expect(json.stderr).not.toContain("[y/N]");
    await git(r, "reset", "-q");
    await git(r, "clean", "-qfd");
    const yes = await runAtTerminal(r, ["accept", next, "--commit"], ["y"]);
    expect(yes.status).toBe(0);
    expect(yes.stderr).toBe(q);
    expect(yes.stdout).toContain(`Copied scope from ADR-0001: ${GLOBS.join(", ")}\n`);
  });

  it("exits 2 when the union exceeds 200 globs, and 1 for an agent", async () => {
    const { r, next } = await supersedingRepo();
    const own = Array.from({ length: 199 }, (_, i) => ["--add", `lib/${i}/**`]).flat();
    expect(runAdr(r, ["scope", next, ...own, "--commit"]).status).toBe(0);
    const before = await git(r, "status", "--porcelain");
    const out = runAdr(r, ["--json", "accept", next, "--copy-scope"]);
    expect(out.status).toBe(2);
    expect(JSON.parse(out.stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "usage", message: "202 globs; the limit is 200" },
    });
    expect(await git(r, "status", "--porcelain")).toBe(before);
    const agent = runAdr(r, ["accept", next, "--copy-scope", "--json"], {
      env: { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "niko@example.org" },
    });
    expect(agent.status).toBe(1);
    expect(doc(agent.stdout).findings.map((f) => f.rule)).toEqual(["decision/agent-accepted"]);
  });

  it("takes every copyScope value in the library, asking a function once", async () => {
    const cases: [CopyScope | undefined, string[], number][] = [
      ["copy", GLOBS, 0],
      ["skip", [], 0],
      ["suggest", [], 1],
      [undefined, [], 1],
    ];
    for (const [copyScope, globs, notes] of cases) {
      const { r, next } = await supersedingRepo();
      const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
      const d = await acceptDecision(
        log,
        { id: next, actor: REPO_HUMAN },
        copyScope === undefined ? {} : { copyScope },
      );
      expect(d.ok, String(copyScope)).toBe(true);
      expect(d.decision?.applies_to).toEqual(globs);
      expect(d.notes).toHaveLength(notes);
    }
    const { r, next } = await supersedingRepo();
    const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
    const offers: ScopeOffer[] = [];
    const d = await acceptDecision(
      log,
      { id: next, actor: REPO_HUMAN },
      {
        copyScope: async (offer) => {
          offers.push(offer);
          return true;
        },
      },
    );
    expect(offers).toEqual([
      { id: next, sources: [expect.any(String)], displays: ["ADR-0001"], globs: GLOBS },
    ]);
    expect(d.decision?.applies_to).toEqual(GLOBS);
  });
});
