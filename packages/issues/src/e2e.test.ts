import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createTempRepo } from "@nikovirtala/ledger/testing";
import { expect, it } from "vitest";
import { cliEnv, requireBuilt, runIssues, runJson, TASK_FLAGS } from "./test-support/cli.js";

// adr's built binary, from the workspace package issues depends on.
const ADR_CLI = requireBuilt(
  join(
    dirname(createRequire(import.meta.url).resolve("@nikovirtala/adr/package.json")),
    "dist/cli.js",
  ),
);

type View = {
  id: string;
  display: string;
  state: string;
  blocked: boolean;
  implements: string[];
};
type Write = {
  ok: boolean;
  issue: View | null;
  written: string[];
  commit: string | null;
  findings: { rule: string }[];
};

it("tracks issues and links them to decisions with the built issues and adr binaries", async () => {
  await using repo = await createTempRepo({ files: { "README.md": "orders\n" } });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo.root, env: cliEnv(repo), encoding: "utf8" });
  const adr = (args: string[]) => runIssues(repo, args, { cli: ADR_CLI });
  const ok = (r: { status: number | null; stdout: string; stderr: string }) => {
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    return r;
  };

  // 1. An accepted decision: ADR-0001.
  const proposed = adr([
    "new",
    "Use queues for orders",
    "--section",
    "context=Orders arrive in bursts.",
    "--section",
    "decision=We will put orders on a queue.",
    "--section",
    "scope=services/orders",
    "--section",
    "consequences=One more service to run.",
    "--json",
  ]);
  const decision = (JSON.parse(proposed.stdout) as { decision: { id: string } }).decision.id;
  ok(adr(["accept", decision, "--commit"]));

  // 2. The issue log and three issues: ?2 is part of ?1, ?3 depends on ?2.
  ok(runIssues(repo, ["init", "--commit"]));
  const one = runJson<Write>(repo, [
    "new",
    "Split orders service",
    ...TASK_FLAGS,
    "--label",
    "type:feature",
    "--commit",
  ]);
  expect(one.json.issue?.display).toBe("?1");
  const two = runJson<Write>(repo, [
    "new",
    "Extract the queue consumer",
    ...TASK_FLAGS,
    "--parent",
    "1",
    "--commit",
  ]);
  expect(two.json.issue?.display).toBe("?2");
  const three = runJson<Write>(repo, [
    "new",
    "Move order totals",
    ...TASK_FLAGS,
    "--depends-on",
    "2",
    "--commit",
  ]);
  expect(three.json.issue?.display).toBe("?3");

  // 3. implements ADR-0001, checked against the local decision log.
  ok(runIssues(repo, ["link", "1", "ADR-0001", "--rel", "implements", "--commit"]));
  const show1 = runJson<{
    issue: View;
    references: { rel: string; display: string; status: string | null; checked: boolean }[];
  }>(repo, ["show", "1"]);
  expect(show1.json.issue.implements).toEqual([`adr:${decision}`]);
  expect(show1.json.references).toContainEqual(
    expect.objectContaining({
      rel: "implements",
      display: "ADR-0001",
      status: "accepted",
      checked: true,
    }),
  );

  // 4. Ready work, a blocked start, and a comment.
  expect(runJson<{ issues: View[] }>(repo, ["ready"]).json.issues.map((v) => v.display)).toEqual([
    "?2",
  ]);
  const start = ok(runIssues(repo, ["start", "3"]));
  expect(start.stderr).toContain("issue/started-blocked");
  ok(runIssues(repo, ["comment", "3", "picked up early", "--commit"]));
  expect(runJson<{ comments: unknown[] }>(repo, ["show", "3"]).json.comments).toHaveLength(1);

  // 5. Closing the dependency unblocks ?3; its commit is found by trailer.
  ok(runIssues(repo, ["close", "2", "--commit"]));
  const id2 = two.json.issue?.id ?? "";
  expect(git("log", "-1", "--format=%B")).toContain(`Issue: ${id2}\nIssue-Event: closed`);
  expect(runJson<{ issue: View }>(repo, ["show", "3"]).json.issue.blocked).toBe(false);
  const commits = runJson<{ commits: { subject: string; events: string[] }[] }>(repo, [
    "show",
    "2",
    "--commits",
  ]);
  expect(commits.json.commits).toContainEqual(
    expect.objectContaining({ subject: "docs(issues): close ?2", events: ["closed"] }),
  );

  // 6. Close and reopen the parent; a won't-fix close needs a reason.
  const close1 = ok(
    runIssues(repo, ["close", "1", "--reason", "Both parts are done.", "--commit"]),
  );
  expect(close1.stderr).not.toContain("warning: issue/");
  ok(runIssues(repo, ["reopen", "1", "--reason", "One more part.", "--commit"]));
  const status = git("status", "--porcelain");
  expect(runIssues(repo, ["close", "1", "--resolution", "wontfix"]).status).toBe(1);
  expect(git("status", "--porcelain")).toBe(status);

  // 7. The agent close policy, committed in issues.toml.
  const config = join(repo.root, "docs/issues/issues.toml");
  const original = await readFile(config, "utf8");
  await writeFile(
    config,
    original.replace("close_requires_human = false", "close_requires_human = true"),
  );
  git("commit", "-q", "-am", "chore: require a human to close issues");
  const agent = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "a@example.com" };
  const refused = runJson<Write>(repo, ["close", "3", "--reason", "done"], { env: agent });
  expect(refused.status).toBe(1);
  expect(refused.json.findings.map((f) => f.rule)).toEqual(["issue/agent-closed"]);
  expect(git("status", "--porcelain")).toBe(status);
  await writeFile(config, original);
  git("commit", "-q", "-am", "chore: let agents close issues");
  const closed3 = runJson<Write>(repo, ["close", "3", "--reason", "done", "--commit"], {
    env: agent,
  });
  expect(closed3.status).toBe(0);
  const history = runJson<{
    events: { type: string; actor: { kind: string; on_behalf_of: string | null } }[];
  }>(repo, ["show", "3", "--history"]);
  expect(history.json.events.at(-1)).toMatchObject({
    type: "closed",
    actor: { kind: "agent", on_behalf_of: "a@example.com" },
  });

  // 8. implements a proposed decision, by its id: a warning, not an error.
  const cache = JSON.parse(adr(["new", "Cache order totals", "--json"]).stdout) as {
    decision: { id: string };
  };
  ok(runIssues(repo, ["link", "1", cache.decision.id, "--rel", "implements", "--commit"]));
  const verify = ok(runIssues(repo, ["verify"]));
  expect(verify.stdout).toContain("issue/implements-unaccepted");
  git("add", "-A");
  git("commit", "-q", "-m", "docs(adr): propose to cache order totals");
  const atHead = runJson<{ findings: { rule: string; severity: string }[] }>(repo, [
    "verify",
    "--ref",
    "HEAD",
  ]);
  expect(atHead.status).toBe(0);
  expect(atHead.json.findings.map((f) => f.rule)).toEqual(["issue/implements-unaccepted"]);

  // 9. Listing, history and the current issue.
  expect(runJson<{ issues: View[] }>(repo, ["list"]).json.issues.map((v) => v.display)).toEqual([
    "?1",
  ]);
  ok(runIssues(repo, ["show", "1", "--history"]));
  expect(runIssues(repo, ["work", "3", "--json"]).status).toBe(1);
  ok(runIssues(repo, ["reopen", "2", "--reason", "regressed", "--commit"]));
  ok(runIssues(repo, ["work", "2"]));
  expect(runJson<{ current: View | null }>(repo, ["work"]).json.current?.display).toBe("?2");
}, 180_000);
