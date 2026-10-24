/**
 * adr phase 2b's demo rows 1–10d (design 2b §12) as a gate test: hooks, pre-push with and without
 * an upstream, post-merge, the recovery hint, the index, shallow clones and each new verify check,
 * through the built CLI and git only. CI, commitlint and ark's own clone are the demo's alone.
 */
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { INDEX_AFTER } from "./log-index.js";
import {
  failingPreCommit,
  hintCommand,
  hooksRepo,
  linkAdrBin,
  NYGARD_SECTIONS,
  runAdr,
  runGit,
  runShell,
} from "./test-support/cli.js";
import { INDEX } from "./test-support/index-repo.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await hooksRepo(files);
  repos.push(r);
  return r;
}

type Run = { status: number | null; stdout: string; stderr: string };
/** `adr …args` in `r` (or `cwd`), expecting exit `want`. */
function adr(r: TempRepo, want: number, args: string[], cwd?: string): Run {
  const out = runAdr(r, args, cwd === undefined ? {} : { cwd });
  expect(out.status, `adr ${args.join(" ")}\n${out.stderr}`).toBe(want);
  return out;
}
/** `git …args` in `r` (or `cwd`), hooks included, expecting exit `want`. */
function git(r: TempRepo, want: number, args: string[], cwd?: string): Run {
  const out = runGit(r, args, cwd === undefined ? {} : { cwd });
  expect(out.status, `git ${args.join(" ")}\n${out.stderr}`).toBe(want);
  return out;
}
const FULL = Object.entries(NYGARD_SECTIONS).flatMap(([k, v]) => ["--section", `${k}=${v}`]);
/** Proposes `title` with every section given and commits it; its id. */
function propose(r: TempRepo, title: string, ...more: string[]): string {
  const out = adr(r, 0, ["new", title, ...FULL, "--no-edit", "--json", ...more]);
  return (JSON.parse(out.stdout) as { decision: { id: string } }).decision.id;
}
type Listed = { id: string; title: string; number: number | null };
const list = (r: TempRepo, cwd?: string) =>
  (JSON.parse(adr(r, 0, ["list", "--json"], cwd).stdout) as { decisions: Listed[] }).decisions;
/** `adr init --commit`; with `index`, `[log] index = "committed"` added under its [log] table. */
async function init(r: TempRepo, o: { index?: boolean } = {}): Promise<void> {
  adr(r, 0, ["init", "--commit"]);
  if (o.index !== true) return;
  const path = join(r.root, "docs/adr/adr.toml");
  const toml = await readFile(path, "utf8");
  expect(toml).toMatch(/^\[log\]$/m);
  await writeFile(path, toml.replace(/^\[log\]$/m, '[log]\nindex = "committed"'));
  git(r, 0, ["commit", "-qam", "chore: enable the decision index"]);
}

describe("adr phase 2b demo rows 1–10d", { timeout: 300_000 }, () => {
  it("rows 1–4, 6 and 7b: hooks, trailers, pre-push, post-merge and a failing scope commit", async () => {
    const r = await repo();
    await init(r);
    const postgres = propose(r, "Use Postgres", "--commit");
    adr(r, 0, ["accept", postgres, "--commit"]);

    // 1. hooks install; a tampered event is rejected by pre-commit, a clean commit is accepted.
    expect(adr(r, 0, ["hooks", "install"]).stdout).toContain(
      "adr hooks: pre-commit, commit-msg, pre-push, post-merge",
    );
    const event = git(r, 0, [
      "ls-files",
      `docs/adr/events/${postgres}/*accepted.yaml`,
    ]).stdout.trim();
    const original = await readFile(join(r.root, event), "utf8");
    await writeFile(
      join(r.root, event),
      original.replace(/^(\s*at: ).*$/m, (_, at: string) => `${at}2020-01-01T00:00:00Z`),
    );
    git(r, 0, ["add", event]);
    expect(git(r, 1, ["commit", "-m", "docs: tamper"]).stderr).toContain("append-only/modified");
    git(r, 0, ["restore", "--staged", "--worktree", event]);
    adr(r, 0, ["note", "ADR-0001", "Checked against the new hosting plan."]);
    git(r, 0, ["commit", "-m", "docs(adr): add a note"]);

    // 2. The commit-msg hook added the trailers.
    expect(git(r, 0, ["log", "-1", "--format=%(trailers:only,unfold)"]).stdout).toBe(
      `ADR: ${postgres}\nADR-Event: noted\n\n`,
    );

    // 3. pre-push with an upstream; a tampered commit made with --no-verify is rejected.
    const remote = join(dirname(r.root), "remote.git");
    git(r, 0, ["init", "-q", "--bare", "-b", "main", remote]);
    git(r, 0, ["remote", "add", "origin", remote]);
    git(r, 0, ["push", "-q", "-u", "origin", "main"]);
    const redis = propose(r, "Use Redis", "--commit");
    git(r, 0, ["push", "-q"]);
    await appendFile(join(r.root, event), "tampered\n");
    git(r, 0, ["commit", "-qam", "docs: tamper past the hook", "--no-verify"]);
    // git runs pre-push with its stdout as is, so the findings are on stdout.
    expect(git(r, 1, ["push", "-q"]).stdout).toContain("append-only/modified");
    git(r, 0, ["reset", "-q", "--hard", "@{upstream}"]);

    // 4. pre-push without an upstream, with a remote (clone A for row 6 is made first).
    const a = join(dirname(r.root), "a");
    git(r, 0, ["clone", "-q", remote, a]);
    git(r, 0, ["switch", "-qc", "topic"]);
    adr(r, 0, ["note", "ADR-0001", "Topic branch note.", "--commit"]);
    expect(git(r, 0, ["push", "-q", "origin", "topic"]).stderr).toContain(
      "no upstream for this branch; verifying against origin/main",
    );
    git(r, 0, ["switch", "-q", "main"]);

    // 6. post-merge after a pull shows list --since ORIG_HEAD.
    await linkAdrBin(a);
    adr(r, 0, ["hooks", "install"], a);
    adr(r, 0, ["accept", redis, "--commit"]);
    git(r, 0, ["push", "-q"]);
    const pulled = git(r, 0, ["pull", "-q", "--ff-only"], a);
    const said = pulled.stdout + pulled.stderr;
    expect(said).toContain("Changed since ORIG_HEAD (");
    expect(said).toMatch(/^ADR-0002 .*accepted.*\n {2}\[new: accepted\]$/m);

    // 7b. A 2a-legal write that pre-commit's verify fails: a glob for code not written yet.
    const stripe = propose(r, "Pay with Stripe", "--commit");
    const scoped = adr(r, 2, ["scope", stripe, "--set", "src/payments/**", "--commit"]);
    expect(scoped.stderr).toContain(
      "matches no tracked file; verify (hooks and CI) reports scope/glob-unmatched until a file matches",
    );
    expect(scoped.stderr).toContain("[scope/glob-unmatched]");
  });

  it("row 5: pre-push with no remote verifies the whole log", async () => {
    const r = await repo();
    await init(r);
    adr(r, 0, ["hooks", "install"]);
    const out = runShell(r, `cd '${r.root}' && sh .git/hooks/pre-push origin x </dev/null`);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain("no upstream and no remote; verifying the whole log");
  });

  it("row 7: a failing --commit shows the recovery hint, finished by hand", async () => {
    const r = await repo();
    await init(r, { index: true });
    adr(r, 0, ["index", "--commit"]);
    const x = propose(r, "Use X", "--commit");
    const hook = await failingPreCommit(r);
    const out = adr(r, 2, ["accept", x, "--commit"]);
    expect(out.stderr).toContain("hook says no");
    expect(out.stderr).toContain("Don't run the command again");
    expect(out.stderr.split("\n")).toContain(`  ${INDEX}`);
    expect(out.stderr.split("\n")).toContain("  ADR-Event: accepted");
    expect(out.stderr).toContain(INDEX_AFTER("docs/adr"));
    await rm(hook);
    expect(runShell(r, hintCommand(out.stderr)).status).toBe(0);
    expect(adr(r, 0, ["index", "--no-commit"]).stdout).toBe(`${INDEX} is up to date\n`);
    expect(git(r, 0, ["log", "-1", "--format=%(trailers:only,unfold)"]).stdout).toBe(
      `ADR: ${x}\nADR-Event: accepted\n\n`,
    );
    adr(r, 0, ["verify"]);
    adr(r, 1, ["accept", x]);
  });

  it("row 8: adr index writes index.md, and a stale index fails verify", async () => {
    const r = await repo();
    await init(r, { index: true });
    expect(adr(r, 0, ["index", "--commit"]).stdout).toMatch(/^Committed docs\/adr\/index\.md as /);
    adr(r, 0, ["accept", propose(r, "Use Postgres", "--commit"), "--commit"]);
    propose(r, "Use Kafka", "--commit");
    const path = join(r.root, INDEX);
    const text = await readFile(path, "utf8");
    expect(text).toContain("[Use Kafka]");
    await writeFile(path, text.replace("[Use Kafka]", "[Use RabbitMQ]"));
    expect(adr(r, 1, ["verify"]).stdout).toContain("[index/stale]");
    adr(r, 0, ["index"]);
    adr(r, 0, ["verify"]);
  });

  it("row 9: a shallow clone shows display numbers from the committed index", async () => {
    const r = await repo();
    await init(r, { index: true });
    for (const t of ["One", "Two", "Three"]) {
      adr(r, 0, ["accept", propose(r, `Decide ${t}`, "--commit"), "--commit"]);
    }
    const four = propose(r, "Decide Four", "--commit");
    const shallow = join(dirname(r.root), "shallow");
    git(r, 0, ["clone", "-q", "--depth", "1", `file://${r.root}`, shallow]);
    const listed = adr(r, 0, ["list"], shallow);
    expect(listed.stderr).toContain("numbers come from docs/adr/index.md (shallow clone)");
    expect(JSON.parse(adr(r, 0, ["list", "--json"], shallow).stdout).numbering.reason).toBe(
      "index",
    );
    adr(r, 0, ["show", "ADR-0001"], shallow);
    adr(r, 0, ["accept", four, "--no-commit"], shallow);
    const numbers = Object.fromEntries(list(r, shallow).map((d) => [d.title, d.number]));
    expect(numbers).toEqual({
      "Decide One": 1,
      "Decide Two": 2,
      "Decide Three": 3,
      "Decide Four": null,
    });
  });

  it("rows 10a–10d: each new verify check fires on a crafted violation", async () => {
    const r = await repo({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
    await init(r);
    adr(r, 0, ["accept", propose(r, "Decide A", "--commit"), "--commit"]);

    // 10a. A scope glob that matches nothing: the write only notes it, verify fails.
    git(r, 0, ["switch", "-qc", "g10a"]);
    adr(r, 0, ["scope", "ADR-0001", "--set", "nothing/**", "--commit"]);
    expect(adr(r, 1, ["verify", "--base", "main"]).stdout).toContain(
      'scope glob "nothing/**" matches no tracked file [scope/glob-unmatched]',
    );
    git(r, 0, ["switch", "-q", "main"]);

    // 10b. A code anchor naming no decision.
    git(r, 0, ["switch", "-qc", "g10b"]);
    await writeFile(join(r.root, "src/x.ts"), "// adr:aaaaaaaa\n");
    git(r, 0, ["add", "src/x.ts"]);
    git(r, 0, ["commit", "-q", "--no-verify", "-m", "feat: add x"]);
    expect(adr(r, 1, ["verify"]).stdout).toContain(
      "anchor adr:aaaaaaaa names no decision in this log [scope/anchor-missing]",
    );
    git(r, 0, ["switch", "-q", "main"]);

    // 10c. A change governed by a superseded decision: a warning, an error when configured.
    adr(r, 0, ["scope", "ADR-0001", "--set", "src/**", "--commit"]);
    adr(r, 0, [
      "accept",
      propose(r, "Decide B", "--supersedes", "ADR-0001", "--commit"),
      "--commit",
    ]);
    adr(r, 0, ["accept", propose(r, "Decide C", "--commit"), "--commit"]);
    adr(r, 0, ["scope", "ADR-0003", "--set", "src/**", "--commit"]);
    git(r, 0, ["switch", "-qc", "g10c"]);
    await writeFile(join(r.root, "src/a.ts"), "a2\n");
    git(r, 0, ["commit", "-qam", "fix: change a"]);
    expect(adr(r, 0, ["verify", "--base", "main"]).stdout).toContain(
      "src/a.ts: warning: src/a.ts is governed by ADR-0001, which is superseded by ADR-0002; check the change against ADR-0002 [decision/governed-by-inactive]",
    );
    await appendFile(
      join(r.root, "docs/adr/adr.toml"),
      '\n[verify]\ngoverned_by_inactive = "error"\n',
    );
    adr(r, 1, ["verify", "--base", "main"]);
    git(r, 0, ["checkout", "--", "docs/adr/adr.toml"]);
    git(r, 0, ["switch", "-q", "main"]);

    // 10d. Narrowing an accepted scope: a warning naming the file it no longer covers.
    git(r, 0, ["switch", "-qc", "g10d"]);
    adr(r, 0, ["scope", "ADR-0003", "--set", "src/a.ts", "--commit"]);
    const narrowed = adr(r, 0, ["verify", "--base", "main"]).stdout;
    expect(narrowed).toContain(
      "ADR-0003's scope no longer covers 1 file that still exists (src/b.ts); check the change against its Scope section [decision/scope-narrowed]",
    );
    git(r, 0, ["switch", "-q", "main"]);
  });
});
