/**
 * CLI spot rows of the index × `--commit` invariant (`write.index.test.ts` runs the full matrix
 * in-process): one row per precondition with the built binary. After each commit, `index --check
 * --ref HEAD` and `verify --ref HEAD` pass, and the work tree's index is current.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { createTempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runIssues, runJson, TASK_FLAGS } from "../test-support/cli.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
const ROOT = "docs/issues";
const INDEX = `${ROOT}/index.md`;
const CONFIG = '[log]\nindex = "committed"\n';

function ok(r: TempRepo, args: string[]): string {
  const out = runIssues(r, args);
  expect(out.status, `issues ${args.join(" ")}\n${out.stdout}${out.stderr}`).toBe(0);
  return out.stdout;
}
function open(r: TempRepo, title: string, commit: boolean): string {
  const out = runJson<{ issue: { id: string } }>(r, [
    "new",
    title,
    ...TASK_FLAGS,
    ...(commit ? ["--commit"] : []),
  ]);
  expect(out.status, out.stderr).toBe(0);
  return out.json.issue.id;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

async function arrange(pre: number): Promise<{ r: TempRepo; x: string; args: string[] }> {
  const config = pre === 8 ? `${CONFIG}\n[policy]\nauto_commit = true\n` : CONFIG;
  const r = await createTempRepo(
    pre === 7 ? {} : { files: { "README.md": "readme\n", [`${ROOT}/issues.toml`]: config } },
  );
  repos.push(r);
  if (pre === 7) {
    await r.write(`${ROOT}/issues.toml`, config);
    await r.stage(`${ROOT}/issues.toml`);
  }
  const committed = pre !== 2 && pre !== 7;
  ok(r, ["init", ...(committed ? ["--commit"] : [])]);
  const x = open(r, "The subject", committed);
  if (pre === 1) {
    open(r, "Staged other", false);
  } else if (pre === 3) {
    const y = open(r, "Not yet in HEAD", false);
    ok(r, ["link", x, y]);
  } else if (pre === 4) {
    const path = (await git(r, "ls-files", `${ROOT}/items`)).split("\n").find((p) => p.includes(x));
    const abs = join(r.root, path ?? "");
    await writeFile(abs, (await readFile(abs, "utf8")).replace(/^# .*$/m, "# Retitled"));
    await r.stage(path ?? "");
  } else if (pre === 5) {
    open(r, "Another", true);
    await git(r, "show", "HEAD~1:docs/issues/index.md").then((t) =>
      writeFile(join(r.root, INDEX), t),
    );
    await git(r, "commit", "-qam", "chore: an older index");
    ok(r, ["index"]);
  } else if (pre === 6) {
    await git(r, "rm", "-q", "--", INDEX);
    await git(r, "commit", "-qm", "chore: drop the index");
  }
  return { r, x, args: ["comment", x, "A comment.", ...(pre === 8 ? [] : ["--commit"])] };
}

describe("issues writes keep index.md fresh, through the binary", { timeout: 120_000 }, () => {
  for (const pre of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`precondition ${pre}`, async () => {
      const { r, args } = await arrange(pre);
      ok(r, args);
      // On an unborn HEAD the config stays staged, outside the commit, so HEAD has no index
      // setting to check against; the in-process matrix checks HEAD's copy there.
      if (pre !== 7) {
        expect(ok(r, ["index", "--check", "--ref", "HEAD"])).toBe(`${INDEX} is up to date\n`);
      }
      const verify = runIssues(r, ["verify", "--ref", "HEAD"]);
      expect(verify.status, verify.stdout).toBe(0);
      const wt = runIssues(r, ["index", "--check"]);
      expect(wt.status, wt.stdout).toBe(0);
    });
  }
});
