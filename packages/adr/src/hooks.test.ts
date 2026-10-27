import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { decisionHookCommands, runPreCommitHook } from "./hooks.js";
import { openDecisionLog } from "./log.js";
import { cliRepo, runAdr, seedDecision } from "./test-support/cli.js";
import { cliEnv } from "./test-support/decision-arbs.js";

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
const open = (r: TempRepo, o: { root?: string; reader?: "index" } = {}) =>
  openDecisionLog({ cwd: r.root, gitOptions: { env: r.env }, ...o });

describe("decisionHookCommands", () => {
  it("adds --root only when the root can't be found without it", async () => {
    const r = await repo({ "decisions/README.md": "x\n" });
    expect(decisionHookCommands(await open(r))).toEqual({
      "pre-commit": ["hooks", "run", "pre-commit"],
      "commit-msg": ["hooks", "trailers", "{args}"],
      "pre-push": ["verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
      "post-merge": ["list", "--since", "ORIG_HEAD"],
    });
    const R = ["--root", "decisions"];
    expect(decisionHookCommands(await open(r, { root: "decisions" }))).toEqual({
      "pre-commit": [...R, "hooks", "run", "pre-commit"],
      "commit-msg": [...R, "hooks", "trailers", "{args}"],
      "pre-push": [...R, "verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
      "post-merge": [...R, "list", "--since", "ORIG_HEAD"],
    });
    // A repo-level adr.toml naming the root finds it, so the hooks don't need --root.
    await r.write("adr.toml", '[log]\nroot = "decisions"\n');
    const named = await open(r);
    expect(named.layout.root).toBe("decisions");
    expect(decisionHookCommands(named)["pre-commit"]).toEqual(["hooks", "run", "pre-commit"]);
  });
});

describe("runPreCommitHook", { timeout: 60_000 }, () => {
  /** An accepted decision scoped to src/orders/**, then a staged git mv of src/orders. */
  async function moved(config?: string): Promise<{ r: TempRepo; a: string }> {
    const r = await repo({
      "src/orders/api.ts": "export {};\n",
      ...(config === undefined ? {} : { "docs/adr/adr.toml": config }),
    });
    const a = await seedDecision(r, "Use Aurora for orders");
    expect(runAdr(r, ["scope", a, "--set", "src/orders/**", "--commit"]).status).toBe(0);
    await git(r, "mv", "src/orders", "src/billing");
    return { r, a };
  }
  const run = async (r: TempRepo, env: NodeJS.ProcessEnv = cliEnv(r)) =>
    runPreCommitHook({
      worktree: await open(r),
      index: await open(r, { reader: "index" }),
      env,
    });
  const stagedLog = async (r: TempRepo) =>
    (await git(r, "diff", "--cached", "--name-only", "--", "docs/adr")).split("\n").filter(Boolean);

  it("stages the scoped event and verifies it in the same call, in stage mode", async () => {
    const { r, a } = await moved();
    const out = await run(r);
    expect(out).toMatchObject({ exit: 0, findings: [], failOn: "error" });
    const staged = await stagedLog(r);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatch(new RegExp(`^docs/adr/events/${a}/\\S+-scoped\\.yaml$`));
  });

  it("only notes the renames in warn mode, and stages nothing", async () => {
    const { r } = await moved('[hooks]\nscope_follow_renames = "warn"\n');
    const out = await run(r);
    expect(out).toMatchObject({ exit: 0, findings: [] });
    expect(out.notes).toEqual([
      `ADR-0001's globs don't follow the renames in this commit (scope_follow_renames = "warn"); run adr scope --follow-renames`,
    ]);
    expect(await stagedLog(r)).toEqual([]);
  });

  it("refuses to stage while git commits a temporary index", async () => {
    const { r } = await moved();
    const env = { ...cliEnv(r), GIT_INDEX_FILE: join(r.git.gitDir, "next-index-1.lock") };
    const out = await run(r, env);
    expect(out.exit).toBe(1);
    expect(out.notes[0]).toMatch(/^the renames in this commit change the scope of ADR-0001; /);
    expect(await stagedLog(r)).toEqual([]);
  });

  it("fails on an unchanged agent-accepted decision when only the staged policy changes", async () => {
    const r = await repo({ "docs/adr/adr.toml": "[policy]\naccept_requires_human = false\n" });
    const a = await seedDecision(r, "Use Aurora for orders", { accept: false });
    const agent = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "ada@example.com" };
    expect(runAdr(r, ["accept", a, "--commit"], { env: agent }).status).toBe(0);
    expect(await run(r)).toMatchObject({ exit: 0, findings: [] });
    await r.write("docs/adr/adr.toml", "[policy]\naccept_requires_human = true\n");
    await r.stage("docs/adr/adr.toml");
    const out = await run(r);
    expect(out.exit).toBe(1);
    expect(out.findings.map((f) => [f.rule, f.subject])).toEqual([["decision/agent-accepted", a]]);
  });

  it("skips rename following when it is off", async () => {
    const { r } = await moved('[hooks]\nscope_follow_renames = "off"\n');
    expect(await run(r)).toMatchObject({ exit: 0, findings: [], notes: [] });
    expect(await stagedLog(r)).toEqual([]);
  });
});
