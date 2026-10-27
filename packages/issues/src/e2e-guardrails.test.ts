import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  hooksRepo,
  type IssuesRun,
  newIssue,
  runAdrCli,
  runGit,
  runIssues,
  runJson,
} from "./test-support/cli.js";
import { issueSource, networkCommands, sourceToml } from "./test-support/sources.js";

// The design addendum's §9.5 rows 1–6 with the built binaries, through real git commits.
const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await hooksRepo(files);
  repos.push(r);
  return r;
}
function ok(out: IssuesRun): IssuesRun {
  expect(out.status, `${out.stdout}${out.stderr}`).toBe(0);
  return out;
}
const git = (r: TempRepo, args: string[]) => ok(runGit(r, args)).stdout;
const CONFIG = "docs/issues/issues.toml";
const NYGARD = ["context", "decision", "scope", "consequences"].flatMap((k) => [
  "--section",
  `${k}=The ${k}.`,
]);

/** A log set up as row 1 does: init over a .gitkeep, committed index, both tools' hooks. */
async function adopted(): Promise<TempRepo> {
  const r = await repo({ "docs/issues/.gitkeep": "" });
  ok(runIssues(r, ["init", "--commit"]));
  const text = await readFile(join(r.root, CONFIG), "utf8");
  await writeFile(join(r.root, CONFIG), text.replace('index = "none"', 'index = "committed"'));
  ok(runGit(r, ["add", CONFIG]));
  ok(runGit(r, ["commit", "-qm", "docs(issues): keep the issue index committed"]));
  ok(runIssues(r, ["index", "--commit"]));
  ok(runAdrCli(r, ["init", "--commit"]));
  ok(runAdrCli(r, ["hooks", "install"]));
  ok(runIssues(r, ["hooks", "install"]));
  return r;
}

describe("issues guardrails end to end", { timeout: 300_000 }, () => {
  it("1. init replaces a placeholder; the index is committed; one shim runs both tools", async () => {
    const r = await adopted();
    const log = git(r, ["log", "--format=%s", "--name-status"]);
    expect(log).toContain("docs(issues): set up the issue log");
    expect(log).toMatch(/D\tdocs\/issues\/\.gitkeep/);
    expect(git(r, ["status", "--porcelain"])).toBe("");
    const shim = await readFile(join(r.git.gitDir, "hooks", "pre-commit"), "utf8");
    expect(shim).toMatch(/adr/);
    expect(shim).toMatch(/issues/);
    ok(runIssues(r, ["index", "--check"]));
  });

  it("2. a batch of staged events gets one subject and one pair per type (?6)", async () => {
    const r = await adopted();
    const a = newIssue(r, "Split the orders service");
    const b = newIssue(r, "Extract the consumer");
    const c = newIssue(r, "Move the schema");
    ok(runIssues(r, ["link", a, b]));
    ok(runIssues(r, ["link", a, c, "--rel", "depends-on"]));
    ok(runIssues(r, ["link", a, b, "--rel", "depends-on"]));
    ok(runIssues(r, ["scope", a, "--set", ".gitignore", "--commit"]));
    expect(
      git(r, ["log", "-1", "--format=%s%n%(trailers:only,unfold)"]).trim().split("\n"),
    ).toEqual([
      'docs(issues): link and scope ?1 "split the orders service"',
      `Issue: ${a}`,
      "Issue-Event: linked",
      `Issue: ${a}`,
      "Issue-Event: scoped",
    ]);
    ok(runIssues(r, ["index", "--check"]));
  });

  it("3. an open issue may name planned code; once started the hook requires it (?7)", async () => {
    const r = await adopted();
    const p = newIssue(r, "Add the planned cache");
    const scoped = ok(runIssues(r, ["scope", p, "--set", "src/planned/**", "--commit"]));
    expect(scoped.stderr).toContain(
      "src/planned/** matches no tracked file; verify reports scope/glob-unmatched once ?1 is started, until a file matches",
    );
    ok(runIssues(r, ["verify"]));
    const started = runIssues(r, ["start", p, "--commit"]);
    expect(started.status).toBe(2);
    expect(started.stderr).toContain("src/planned/** matches no tracked file; from this commit");
    expect(started.stderr).toContain("scope/glob-unmatched");
    await r.write("src/planned/cache.ts", "export {};\n");
    ok(runGit(r, ["add", "src/planned/cache.ts"]));
    ok(runGit(r, ["commit", "-qm", "feat: add the planned cache"]));
    ok(runIssues(r, ["verify"]));
  });

  it("4. a staged adr reject alone warns; a staged mcp_can_close alone fails the commit (?3)", async () => {
    const r = await adopted();
    const proposed = JSON.parse(
      ok(runAdrCli(r, ["new", "Use event sourcing", ...NYGARD, "--no-edit", "--commit", "--json"]))
        .stdout,
    ) as { decision: { id: string } };
    const d = proposed.decision.id;
    const i = newIssue(r, "Build the event store");
    ok(runIssues(r, ["link", i, `adr:${d}`, "--rel", "implements", "--commit"]));
    ok(runAdrCli(r, ["reject", d, "--reason", "Too early."]));
    const staged = runJson<{ findings: { rule: string; subject: string; message: string }[] }>(r, [
      "verify",
      "--staged",
    ]);
    expect(staged.json.findings.map((f) => [f.rule, f.subject])).toEqual([
      ["issue/implements-unaccepted", i],
    ]);
    expect(staged.json.findings[0]?.message).toContain("rejected");
    // The finding is a warning, so the commit goes through.
    ok(runGit(r, ["commit", "-qm", "docs(adr): reject event sourcing"]));

    const agent = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "ada@example.com" };
    const j = newIssue(r, "Closed by an agent");
    ok(runIssues(r, ["close", j, "--reason", "Done by an agent.", "--commit"], { env: agent }));
    const config = await readFile(join(r.root, CONFIG), "utf8");
    await writeFile(
      join(r.root, CONFIG),
      config.replace("mcp_can_close = true", "mcp_can_close = false"),
    );
    ok(runGit(r, ["add", CONFIG]));
    expect(runIssues(r, ["verify", "--staged"]).status).toBe(1);
    const commit = runGit(r, ["commit", "-qm", "docs(issues): stop agents closing issues"]);
    expect(commit.status).toBe(1);
    expect(commit.stderr).toContain("issue/agent-closed");
  });

  it("5. sources: cache only by default, --fetch-sources fetches, a failed fetch exits 2 (?3)", async () => {
    const source = await issueSource();
    repos.push(source.src, source.bare);
    const r = await adopted();
    const a = newIssue(r, "Use the platform API");
    await writeFile(
      join(r.root, CONFIG),
      `${await readFile(join(r.root, CONFIG), "utf8")}${sourceToml("platform", source.url)}`,
    );
    ok(runGit(r, ["add", CONFIG]));
    ok(runGit(r, ["commit", "-qm", "docs(issues): read the platform issues"]));
    const target = `platform:${source.issues[0]}`;
    const linked = ok(runIssues(r, ["link", a, target, "--rel", "depends-on", "--commit"]));
    expect(linked.stderr).toContain("platform not fetched; the reference isn't checked");

    const trace = join(r.root, "..", "trace.json");
    const plain = ok(runIssues(r, ["verify"], { env: { GIT_TRACE2_EVENT: trace } }));
    expect(plain.stdout.match(/sources\/not-fetched/g)).toHaveLength(1);
    expect(await networkCommands(trace)).toEqual([]);

    ok(runIssues(r, ["sources", "fetch"]));
    const head = (await source.src.git.resolveCommit("HEAD")) ?? "";
    const fetched = runJson<{ sources: { name: string; commit: string; fetched: boolean }[] }>(r, [
      "verify",
      "--fetch-sources",
    ]);
    expect(fetched.status).toBe(0);
    expect(fetched.json.sources).toEqual([
      expect.objectContaining({ name: "platform", commit: head, fetched: true }),
    ]);
    const listed = ok(runIssues(r, ["list", "--source", "platform"]));
    expect(listed.stdout).toContain("Provide the platform API");

    const text = await readFile(join(r.root, CONFIG), "utf8");
    for (const ref of ["refs/heads/main", "v1", head]) {
      await writeFile(join(r.root, CONFIG), text.replace('ref = "main"', `ref = "${ref}"`));
      const pinned = runJson<{ sources: { commit: string }[] }>(r, ["verify", "--fetch-sources"]);
      expect(pinned.status, ref).toBe(0);
      expect(pinned.json.sources[0]?.commit, ref).toBe(head);
    }
    await writeFile(join(r.root, CONFIG), text);
    await source.bare.dispose();
    const failed = runIssues(r, ["verify", "--fetch-sources"]);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toMatch(/cannot fetch source platform \(main\)/);
    ok(runIssues(r, ["verify"]));
  });

  it("6. commit-msg adds Issue: for the current issue, and warns about fixes ?N (?3)", async () => {
    const r = await adopted();
    const a = newIssue(r, "Handle the timeout");
    ok(runIssues(r, ["work", a]));
    ok(runGit(r, ["commit", "-q", "--allow-empty", "-m", "chore: try the commit-msg hook"]));
    expect(git(r, ["log", "-1", "--format=%(trailers:only,unfold)"]).trim()).toBe(`Issue: ${a}`);
    const fixes = ok(
      runGit(r, ["commit", "-q", "--allow-empty", "-m", "fix: handle the timeout, fixes ?1"]),
    );
    expect(fixes.stderr).toContain(
      'the message says "fixes ?1", but ?1 has no staged closed event; issues don\'t close from commit messages, so run issues close 1 in this pull request',
    );
  });
});
