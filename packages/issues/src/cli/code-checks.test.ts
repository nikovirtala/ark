import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues } from "../test-support/cli.js";

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
function ok(r: TempRepo, args: string[]) {
  const out = runIssues(r, args);
  expect(out.status, `issues ${args.join(" ")}\n${out.stdout}${out.stderr}`).toBe(0);
  return out;
}

describe("scope globs on planned work (?7)", { timeout: 60_000 }, () => {
  it("lets an open issue name code that doesn't exist, and checks it once started", async () => {
    const r = await repo();
    const x = newIssue(r, "Add the planned cache");
    const scoped = ok(r, ["scope", x, "--set", "src/planned/**", "--commit"]);
    expect(scoped.stderr).toContain(
      "issues: warning: src/planned/** matches no tracked file; verify reports scope/glob-unmatched once ?1 is started, until a file matches\n",
    );
    expect(ok(r, ["verify"]).stdout).toBe("No findings.\n");
    const started = ok(r, ["start", x, "--commit"]);
    expect(started.stderr).toContain(
      "issues: warning: src/planned/** matches no tracked file; from this commit verify reports scope/glob-unmatched until a file matches, so commit the files with it or change the scope\n",
    );
    const verify = runIssues(r, ["verify"]);
    expect(verify.status).toBe(1);
    expect(verify.stdout).toContain('scope glob "src/planned/**" matches no tracked file');
    expect(verify.stdout).toContain("[scope/glob-unmatched]");
    const more = ok(r, ["scope", x, "--add", "src/later/**"]);
    expect(more.stderr).toContain(
      "issues: warning: src/later/** matches no tracked file; verify (hooks and CI) reports scope/glob-unmatched until a file matches\n",
    );
    await mkdir(join(r.root, "src/planned"), { recursive: true });
    await writeFile(join(r.root, "src/planned/cache.ts"), "export {};\n");
    await git(r, "add", "src/planned/cache.ts");
    await git(r, "commit", "-qm", "feat: add the cache");
    ok(r, ["scope", x, "--remove", "src/later/**"]);
    expect(ok(r, ["verify"]).stdout).toBe("No findings.\n");
  });
});

describe("code anchors", { timeout: 60_000 }, () => {
  it("reports anchors to unknown and closed issues, and skips excluded files", async () => {
    const r = await repo({
      "docs/issues/issues.toml": '[scope]\nanchor_exclude = ["docs/**"]\n',
    });
    const open = newIssue(r, "Still open");
    const done = newIssue(r, "Done already");
    const dup = newIssue(r, "A duplicate");
    ok(r, ["close", done, "--commit"]);
    ok(r, ["close", dup, "--duplicate-of", open, "--reason", "Same work.", "--commit"]);
    await mkdir(join(r.root, "src"), { recursive: true });
    await mkdir(join(r.root, "docs/notes"), { recursive: true });
    await writeFile(
      join(r.root, "src/a.ts"),
      `// issue:${open}\n// issue:${done}\n// issue:${dup}\n// issue:zzzzzzzz\n`,
    );
    await writeFile(join(r.root, "docs/notes/x.md"), "<!-- issue:zzzzzzzz -->\n");
    await git(r, "add", "src", "docs/notes");
    const staged = runIssues(r, ["verify", "--staged"]);
    expect(staged.status).toBe(1);
    expect(staged.stdout).toBe(
      [
        "src/a.ts:2: warning: anchor issue:" +
          done +
          " names ?2, which is closed; remove the anchor or reopen the issue [issue/stale-anchor] (" +
          done +
          ")",
        `src/a.ts:3: warning: anchor issue:${dup} names ?3, which is closed as a duplicate of ?1; anchor ?1 instead [issue/stale-anchor] (${dup})`,
        "src/a.ts:4: error: anchor issue:zzzzzzzz names no issue in this log [scope/anchor-missing] (zzzzzzzz)",
        "",
        "1 error, 2 warnings",
        "",
      ].join("\n"),
    );
    await git(r, "commit", "-qm", "feat: anchors");
    expect(runIssues(r, ["verify"]).stdout).toBe(staged.stdout);
  });
});
