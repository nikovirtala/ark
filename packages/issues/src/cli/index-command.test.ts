import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
const CONFIG = { "docs/issues/issues.toml": '[log]\nindex = "committed"\n' };
async function repo(files: Record<string, string> = CONFIG): Promise<TempRepo> {
  const r = await cliRepo(files);
  repos.push(r);
  return r;
}
const INDEX = "docs/issues/index.md";
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

describe("issues index", { timeout: 60_000 }, () => {
  it("checks, writes and commits index.md", async () => {
    const r = await repo();
    newIssue(r, "Split the orders service");
    // The write committed the index with the issue.
    expect(runIssues(r, ["index", "--check", "--ref", "HEAD"]).status).toBe(0);
    await git(r, "rm", "-q", INDEX);
    await git(r, "commit", "-qm", "chore: drop the index");
    const missing = runIssues(r, ["index", "--check"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("[index/missing]");

    const committed = runJson<{ format: string; commit: string | null; fresh: boolean }>(r, [
      "index",
      "--commit",
    ]);
    expect(committed.status).toBe(0);
    expect(committed.json).toMatchObject({ format: "issues-index/v1", fresh: false });
    expect(await git(r, "log", "-1", "--format=%s%n%(trailers:only)")).toBe(
      "docs(issues): regenerate the issue index\n\n",
    );
    expect(runIssues(r, ["index", "--check"])).toMatchObject({
      status: 0,
      stdout: `${INDEX} is up to date\n`,
    });
    expect(runIssues(r, ["index", "--check", "--ref", "HEAD"]).status).toBe(0);
    expect(runIssues(r, ["index", "--commit"]).stdout).toBe(`${INDEX} is up to date\n`);

    // A hand edit is stale; verify reports it too.
    const text = await readFile(join(r.root, INDEX), "utf8");
    await writeFile(join(r.root, INDEX), text.replace("Split", "Splat"));
    const stale = runIssues(r, ["index", "--check"]);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain(
      `${INDEX} is not what the tool generates; run issues index and commit it`,
    );
    const verify = runIssues(r, ["verify"]);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain("[index/stale]");
    expect(runIssues(r, ["index"]).stdout).toBe(`Wrote ${INDEX}\n`);
    expect(runIssues(r, ["verify"]).status).toBe(0);
  });

  it("refuses --ref without --check, --check with --commit, and a log without the index", async () => {
    const r = await repo();
    const err = (args: string[]) => {
      const out = runIssues(r, args);
      expect(out.status).toBe(2);
      return out.stderr;
    };
    expect(err(["index", "--ref", "HEAD"])).toBe(
      "issues: error: issues index writes the work tree; use --ref only with --check\n",
    );
    expect(err(["index", "--check", "--commit"])).toBe(
      "issues: error: --check writes nothing; drop --commit and --message\n",
    );
    const none = await repo({});
    const out = runIssues(none, ["index"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(
      'issues: error: issues index needs [log] index = "committed" in issues.toml\n',
    );
  });
});
