import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDecisionLog, proposeDecision, rejectDecision } from "@nikovirtala/adr";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { issueHookCommands, runPreCommitHook } from "./hooks.js";
import { openIssueLog } from "./log.js";
import {
  cliEnv,
  hooksRepo,
  newIssue,
  REPO_HUMAN,
  runAdrCli,
  runGit,
  runIssues,
} from "./test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await hooksRepo(files);
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
const open = (r: TempRepo, o: { root?: string; reader?: "index" } = {}) =>
  openIssueLog({ cwd: r.root, gitOptions: { env: r.env }, ...o });
const run = async (r: TempRepo, env: NodeJS.ProcessEnv = cliEnv(r)) =>
  runPreCommitHook({ worktree: await open(r), index: await open(r, { reader: "index" }), env });
const trailers = async (r: TempRepo) =>
  (await git(r, "log", "-1", "--format=%(trailers:only,unfold)")).trim().split("\n");
const stagedLog = async (r: TempRepo) =>
  (await git(r, "diff", "--cached", "--name-only", "--", "docs/issues"))
    .split("\n")
    .filter(Boolean);
const NYGARD = {
  context: "We need a queue.",
  decision: "We will use a queue.",
  scope: "services/orders",
  consequences: "One more service.",
};
function ok(out: { status: number | null; stdout: string; stderr: string }) {
  expect(out.status, `${out.stdout}${out.stderr}`).toBe(0);
  return out;
}

describe("issueHookCommands", () => {
  it("adds --root only when the root can't be found without it", async () => {
    const r = await repo({ "tickets/README.md": "x\n" });
    expect(issueHookCommands(await open(r))).toEqual({
      "pre-commit": ["hooks", "run", "pre-commit"],
      "commit-msg": ["hooks", "trailers", "{args}"],
      "pre-push": ["verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
    });
    const R = ["--root", "tickets"];
    expect(issueHookCommands(await open(r, { root: "tickets" }))["pre-commit"]).toEqual([
      ...R,
      "hooks",
      "run",
      "pre-commit",
    ]);
    await r.write("issues.toml", '[log]\nroot = "tickets"\n');
    expect(issueHookCommands(await open(r))["pre-commit"]).toEqual(["hooks", "run", "pre-commit"]);
  });
});

describe("issues hooks share ledger's shims with adr", { timeout: 120_000 }, () => {
  it("installs next to adr's hooks, one shim per hook, and uninstalls only itself", async () => {
    const r = await repo();
    ok(runAdrCli(r, ["hooks", "install"]));
    const out = ok(runIssues(r, ["hooks", "install"]));
    expect(out.stdout).toBe(
      [
        "wrote .git/hooks/pre-commit",
        "wrote .git/hooks/commit-msg",
        "wrote .git/hooks/pre-push",
        "issues hooks: pre-commit, commit-msg, pre-push",
        "",
      ].join("\n"),
    );
    const shim = await readFile(join(r.git.gitDir, "hooks", "pre-commit"), "utf8");
    expect(shim).toMatch(/adr/);
    expect(shim).toMatch(/issues/);
    const again = JSON.parse(ok(runIssues(r, ["hooks", "install", "--json"])).stdout);
    expect(again).toMatchObject({
      format: "issues-hooks/v1",
      action: "install",
      written: [],
      unchanged: [".git/hooks/pre-commit", ".git/hooks/commit-msg", ".git/hooks/pre-push"],
    });
    expect(ok(runIssues(r, ["hooks", "uninstall"])).stdout).toBe(
      [
        "removed issues from .git/hooks/pre-commit",
        "removed issues from .git/hooks/commit-msg",
        "removed issues from .git/hooks/pre-push",
        "",
      ].join("\n"),
    );
    const left = await readFile(join(r.git.gitDir, "hooks", "pre-commit"), "utf8");
    expect(left).toMatch(/adr/);
    expect(left).not.toMatch(/issues/);
  });

  it("names a foreign hook as a conflict, exit 2", async () => {
    const r = await repo();
    await writeFile(join(r.git.gitDir, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const out = runIssues(r, ["hooks", "install"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/pre-commit/);
    expect(out.stderr).toMatch(/add 'issues hooks run pre-commit' to it/);
  });

  it("prints a snippet for a hook manager", async () => {
    const r = await repo();
    const out = ok(runIssues(r, ["hooks", "print", "--manager", "lefthook"]));
    expect(out.stdout).toMatch(/issues hooks run pre-commit/);
    expect(runIssues(r, ["hooks", "print"]).status).toBe(2);
    expect(runIssues(r, ["hooks", "install", "--manager", "husky"]).status).toBe(2);
    expect(runIssues(r, ["hooks", "run", "pre-push"]).status).toBe(2);
  });
});

describe("runPreCommitHook", { timeout: 120_000 }, () => {
  it("refuses a tampered event", async () => {
    const r = await repo();
    const i = newIssue(r, "Tampered");
    const [path] = (await git(r, "ls-files", `docs/issues/events/${i}`)).trim().split("\n");
    const file = join(r.root, path as string);
    await writeFile(file, (await readFile(file, "utf8")).replace(/^type: .*$/m, "type: exploded"));
    await r.stage(path as string);
    const out = await run(r);
    expect(out.exit).toBe(1);
    expect(out.findings.length).toBeGreaterThan(0);
  });

  it("re-checks every issue when only a staged decision or policy changes", async () => {
    const r = await repo({ "docs/issues/issues.toml": "[policy]\nmcp_can_close = true\n" });
    const adr = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
    const p = await proposeDecision(
      adr,
      { title: "Use a queue", sections: NYGARD, actor: REPO_HUMAN },
      { commit: true },
    );
    const d = p.decision?.id ?? "";
    const i = newIssue(r, "Build the queue");
    ok(runIssues(r, ["link", i, `adr:${d}`, "--rel", "implements", "--commit"]));
    expect(await run(r)).toMatchObject({ exit: 0, findings: [] });

    await rejectDecision(
      adr,
      { id: d, reason: "Too early.", actor: REPO_HUMAN },
      { commit: false },
    );
    const rejected = await run(r);
    expect(rejected.findings.map((f) => [f.rule, f.subject])).toEqual([
      ["issue/implements-unaccepted", i],
    ]);
    await git(r, "reset", "-q", "--hard");

    const agent = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "ada@example.com" };
    const j = newIssue(r, "Closed by an agent");
    ok(runIssues(r, ["close", j, "--reason", "Done.", "--commit"], { env: agent }));
    await r.write("docs/issues/issues.toml", "[policy]\nmcp_can_close = false\n");
    await r.stage("docs/issues/issues.toml");
    const policy = await run(r);
    expect(policy.exit).toBe(1);
    expect(policy.findings.map((f) => [f.rule, f.subject])).toContainEqual([
      "issue/agent-closed",
      j,
    ]);
  });

  it('stages a fresh index.md with [hooks] index = "stage", and only checks it otherwise', async () => {
    const config = '[log]\nindex = "committed"\n';
    const r = await repo({ "docs/issues/issues.toml": `${config}[hooks]\nindex = "stage"\n` });
    ok(runIssues(r, ["index", "--commit"]));
    newIssue(r, "Indexed");
    await r.write("docs/issues/index.md", "stale\n");
    await r.stage("docs/issues/index.md");
    const out = await run(r);
    expect(out).toMatchObject({ exit: 0, findings: [] });
    expect(out.notes).toContain("regenerated and staged docs/issues/index.md");
    expect(ok(runIssues(r, ["index", "--check"])).status).toBe(0);

    await r.write("docs/issues/issues.toml", config);
    await r.write("docs/issues/index.md", "stale\n");
    await r.stage("docs/issues/issues.toml", "docs/issues/index.md");
    const check = await run(r);
    expect(check.exit).toBe(1);
    expect(check.findings.map((f) => f.rule)).toContain("index/stale");
  });

  it("follows staged renames into the scope, or only notes them in warn mode", async () => {
    const r = await repo({ "src/orders/api.ts": "export {};\n" });
    const i = newIssue(r, "Move orders");
    ok(runIssues(r, ["scope", i, "--set", "src/orders/**", "--commit"]));
    await git(r, "mv", "src/orders", "src/billing");
    const out = await run(r);
    expect(out).toMatchObject({ exit: 0, findings: [] });
    const staged = await stagedLog(r);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatch(new RegExp(`^docs/issues/events/${i}/\\S+-scoped\\.yaml$`));

    await git(r, "reset", "-q", "--hard");
    await r.write("docs/issues/issues.toml", '[hooks]\nscope_follow_renames = "warn"\n');
    ok(runGit(r, ["add", "docs/issues/issues.toml"]));
    ok(runGit(r, ["commit", "-qm", "chore: warn about renames"]));
    await git(r, "mv", "src/orders", "src/billing");
    const warn = await run(r);
    expect(warn.exit).toBe(0);
    expect(warn.notes.some((n) => /don't follow the renames/.test(n))).toBe(true);
    expect(await stagedLog(r)).toEqual([]);
  });
});

describe("the commit-msg hook", { timeout: 180_000 }, () => {
  async function installed(): Promise<TempRepo> {
    const r = await repo();
    ok(runAdrCli(r, ["hooks", "install"]));
    ok(runIssues(r, ["hooks", "install"]));
    return r;
  }

  it("adds Issue: <current> once to an issues edit --commit", async () => {
    const r = await installed();
    const x = newIssue(r, "Current work");
    ok(runIssues(r, ["work", x]));
    ok(runIssues(r, ["edit", x, "--title", "Current work, retitled", "--commit"]));
    expect((await trailers(r)).filter((t) => t === `Issue: ${x}`)).toHaveLength(1);
  });

  it("adds Issue: <current> to adr's commits, after adr's own pair", async () => {
    const r = await installed();
    const x = newIssue(r, "Decide the queue");
    ok(runIssues(r, ["work", x]));
    const flags = Object.entries(NYGARD).flatMap(([k, v]) => ["--section", `${k}=${v}`]);
    ok(runAdrCli(r, ["new", "Use a queue", ...flags, "--no-edit", "--commit"]));
    const committed = await trailers(r);
    expect(committed.filter((t) => t.startsWith("ADR-Event:"))).toEqual(["ADR-Event: proposed"]);
    expect(committed.filter((t) => t === `Issue: ${x}`)).toHaveLength(1);

    ok(runAdrCli(r, ["new", "Use a stream", ...flags, "--no-edit"]));
    ok(runGit(r, ["commit", "-qm", "docs(adr): propose to use a stream"]));
    const plain = await trailers(r);
    expect(plain.filter((t) => t.startsWith("ADR-Event:"))).toEqual(["ADR-Event: proposed"]);
    expect(plain.filter((t) => t === `Issue: ${x}`)).toHaveLength(1);
  });

  it("writes one pair per issue and event type for a plain commit of staged events", async () => {
    const r = await installed();
    const a = newIssue(r, "Split the orders service");
    const b = newIssue(r, "Extract the consumer");
    const c = newIssue(r, "Move the schema");
    ok(runIssues(r, ["link", a, b]));
    ok(runIssues(r, ["link", a, c, "--rel", "depends-on"]));
    ok(runIssues(r, ["link", a, b, "--rel", "depends-on"]));
    ok(runGit(r, ["commit", "-qm", "docs(issues): link the orders work"]));
    expect(await trailers(r)).toEqual([`Issue: ${a}`, "Issue-Event: linked"]);
  });

  it("warns about fixes ?N without a staged close, and notes a closed current issue", async () => {
    const r = await installed();
    const x = newIssue(r, "Handle the timeout");
    const shown = JSON.parse(ok(runIssues(r, ["show", x, "--json"])).stdout).issue.display;
    const out = ok(
      runGit(r, ["commit", "-q", "--allow-empty", "-m", `fix: time out, fixes ${shown}`]),
    );
    expect(out.stderr).toContain(
      `the message says "fixes ${shown}", but ${shown} has no staged closed event; issues don't close from commit messages, so run issues close ${shown.replace(/^\?/, "")} in this pull request`,
    );
    ok(runIssues(r, ["close", x, "--reason", "Timed out."]));
    const closing = ok(runGit(r, ["commit", "-q", "-m", `fix: time out, closes ${shown}`]));
    expect(closing.stderr).not.toMatch(/no staged closed event/);

    const y = newIssue(r, "Already closed");
    ok(runIssues(r, ["work", y]));
    ok(runIssues(r, ["close", y, "--reason", "Done.", "--commit"]));
    const after = ok(runGit(r, ["commit", "-q", "--allow-empty", "-m", "chore: tidy"]));
    expect(after.stderr).toMatch(/the current issue \S+ is closed; run issues work --clear/);
    expect((await trailers(r)).filter((t) => t.startsWith("Issue:"))).toEqual([]);
  });
});
