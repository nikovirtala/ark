import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptDecision,
  openDecisionLog,
  proposeDecision,
  rejectDecision,
  supersedeDecision,
} from "@nikovirtala/adr";
import { verifyLog } from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { issueKind } from "./kind.js";
import { openIssueLog } from "./log.js";
import { cliRepo, newIssue, REPO_HUMAN, runIssues, runJson } from "./test-support/cli.js";
import { issuesChecks } from "./verify.js";

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
const NYGARD = {
  context: "We need a queue.",
  decision: "We will use a queue.",
  scope: "services/orders",
  consequences: "One more service.",
};
const AGENT = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "ada@example.com" };

async function propose(r: TempRepo, title: string, accept: boolean): Promise<string> {
  const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
  const p = await proposeDecision(
    log,
    { title, sections: NYGARD, actor: REPO_HUMAN },
    { commit: true },
  );
  const id = p.decision?.id ?? "";
  if (accept) await acceptDecision(log, { id, actor: REPO_HUMAN }, { commit: true });
  return id;
}

type Found = { rule: string; subject: string | null; message: string };
const staged = (r: TempRepo) => {
  const out = runJson<{ findings: Found[] }>(r, ["verify", "--staged"]);
  return { status: out.status, stderr: out.stderr, found: out.json.findings };
};
const rules = (fs: readonly Found[]) => fs.map((f) => [f.rule, f.subject]);

async function setConfig(r: TempRepo, path: string, text: string): Promise<void> {
  await writeFile(join(r.root, path), text);
  await git(r, "add", "--", path);
}

describe("issues verify --staged re-checks every issue when an input changes", {
  timeout: 120_000,
}, () => {
  it("a staged adr reject alone reports the unchanged implementing issue", async () => {
    const r = await repo();
    const d = await propose(r, "Use a queue", false);
    const i = newIssue(r, "Build the queue");
    expect(runIssues(r, ["link", i, `adr:${d}`, "--rel", "implements", "--commit"]).status).toBe(0);
    expect(staged(r).found).toEqual([]);
    const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
    await rejectDecision(
      log,
      { id: d, reason: "Too early.", actor: REPO_HUMAN },
      { commit: false },
    );
    const out = staged(r);
    expect(rules(out.found)).toEqual([["issue/implements-unaccepted", i]]);
    expect(out.found[0]?.message).toContain("which is rejected");
    expect(out.stderr).toMatch(/--staged checks every issue: the staged changes touch docs\/adr\//);
    // ledger's verifyLog without the inputs keeps the touched-only scope.
    const issues = await openIssueLog({ cwd: r.root, reader: "index", gitOptions: { env: r.env } });
    const { readSourceLogs } = await import("./sources.js");
    const narrow = await verifyLog({
      git: issues.git,
      kind: issueKind,
      layout: issues.layout,
      mode: { type: "staged" },
      checks: issuesChecks(issues, "HEAD", await readSourceLogs(issues)),
    });
    expect(narrow).toEqual([]);
  });

  it("a staged supersede alone names the effective decision", async () => {
    const r = await repo();
    const d = await propose(r, "Use a queue", true);
    const e = await propose(r, "Use a stream", true);
    const i = newIssue(r, "Build the queue");
    expect(runIssues(r, ["link", i, `adr:${d}`, "--rel", "implements", "--commit"]).status).toBe(0);
    const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
    await supersedeDecision(log, { id: d, by: e, actor: REPO_HUMAN }, { commit: false });
    const out = staged(r);
    expect(rules(out.found)).toEqual([["issue/implements-unaccepted", i]]);
    expect(out.found[0]?.message).toContain(`the decision in force is adr:${e}`);
  });

  it("a staged policy or label change alone reports unchanged issues", async () => {
    const r = await repo({ "docs/issues/issues.toml": "[policy]\nmcp_can_close = true\n" });
    const i = newIssue(r, "Closed by an agent");
    const closed = runIssues(r, ["close", i, "--reason", "Done by an agent.", "--commit"], {
      env: AGENT,
    });
    expect(closed.status, closed.stderr).toBe(0);
    const j = newIssue(r, "Two priorities");
    expect(
      runIssues(r, ["label", j, "--add", "priority:high", "--add", "priority:low", "--commit"])
        .status,
    ).toBe(0);
    expect(staged(r).found).toEqual([]);

    await setConfig(r, "docs/issues/issues.toml", "[policy]\nmcp_can_close = false\n");
    const agent = staged(r);
    expect(agent.status).toBe(1);
    expect(rules(agent.found)).toContainEqual(["issue/agent-closed", i]);

    await setConfig(r, "docs/issues/issues.toml", "[policy]\nclose_requires_human = true\n");
    const human = staged(r);
    expect(human.status).toBe(1);
    expect(human.found.map((f) => f.subject)).toContain(i);

    await setConfig(r, "docs/issues/issues.toml", '[labels]\nexclusive = ["priority"]\n');
    expect(rules(staged(r).found)).toContainEqual(["issue/label-exclusive", j]);
  });

  it("a staged template edit alone re-lints an unchanged open issue", async () => {
    const r = await repo();
    const i = newIssue(r, "Template linted");
    const path = "docs/issues/templates/task.md";
    const text = await readFile(join(r.root, path), "utf8");
    const stricter = `${text.replace(
      "sections:\n",
      "sections:\n  - id: risks\n    heading: Risks\n    required: true\n",
    )}\n## Risks\n{{risks}}\n`;
    expect(stricter).not.toBe(text);
    await setConfig(r, path, stricter);
    const out = staged(r);
    expect(out.found, out.stderr).toBeDefined();
    expect(out.found.map((f) => [f.rule.startsWith("template/"), f.subject])).toContainEqual([
      true,
      i,
    ]);
  });

  it("a staged removal of the decision log alone reports adr: links", async () => {
    const r = await repo();
    const d = await propose(r, "Use a queue", true);
    const i = newIssue(r, "Build the queue");
    expect(runIssues(r, ["link", i, `adr:${d}`, "--rel", "implements", "--commit"]).status).toBe(0);
    await git(r, "rm", "-rq", "docs/adr");
    expect(rules(staged(r).found)).toContainEqual(["issue/unknown-source", i]);
  });
});
