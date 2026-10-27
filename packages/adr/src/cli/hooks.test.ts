import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type HookManager, hookSnippet } from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  hooksRepo,
  linkAdrBin,
  NYGARD_SECTIONS,
  runAdr,
  runGit,
  seedDecision,
} from "../test-support/cli.js";
import { freshIndex, INDEX, INDEX_CONFIG, indexCopies } from "../test-support/index-repo.js";
import { WRITE_RERUN } from "../write.js";

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
const trailers = (r: TempRepo, rev = "HEAD") =>
  git(r, "log", "-1", "--format=%(trailers:only,unfold)", rev);
const FULL = Object.entries(NYGARD_SECTIONS).flatMap(([k, v]) => ["--section", `${k}=${v}`]);
/** Proposes `title` without committing; its id. */
function propose(r: TempRepo, title: string): string {
  const out = runAdr(r, ["new", title, ...FULL, "--no-edit", "--json"]);
  expect(out.status, out.stderr).toBe(0);
  return (JSON.parse(out.stdout) as { decision: { id: string } }).decision.id;
}
function install(r: TempRepo, cwd?: string): void {
  const out = runAdr(r, ["hooks", "install"], cwd === undefined ? {} : { cwd });
  expect(out.status, out.stderr).toBe(0);
}

const SHIMS = ["pre-commit", "commit-msg", "pre-push", "post-merge"].map((h) => `.git/hooks/${h}`);
const REGISTRATIONS = [
  { hook: "pre-commit", argv: ["hooks", "run", "pre-commit"] },
  { hook: "commit-msg", argv: ["hooks", "trailers", "{args}"] },
  {
    hook: "pre-push",
    argv: ["verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
  },
  { hook: "post-merge", argv: ["list", "--since", "ORIG_HEAD"] },
] as const;
const HOOKS_LINE = "adr hooks: pre-commit, commit-msg, pre-push, post-merge";

/** An accepted ADR-0001 scoped to `src/orders/**`, committed, with the hooks installed. */
async function scopedRepo(config?: string): Promise<{ r: TempRepo; a: string }> {
  const r = await repo({
    "src/orders/api.ts": "export {};\n",
    ...(config === undefined ? {} : { "docs/adr/adr.toml": config }),
  });
  const a = await seedDecision(r, "Use Aurora for orders");
  expect(runAdr(r, ["scope", a, "--set", "src/orders/**", "--commit"]).status).toBe(0);
  install(r);
  return { r, a };
}

// 01:336–347, design 2b D4, D8 and §4.3.
describe("adr hooks", { timeout: 120_000 }, () => {
  it("installs four shims, reports them unchanged the second time, and uninstalls them", async () => {
    const r = await repo();
    expect(runAdr(r, ["hooks", "install"])).toEqual({
      status: 0,
      stdout: [...SHIMS.map((s) => `wrote ${s}`), HOOKS_LINE, ""].join("\n"),
      stderr: "",
    });
    const again = runAdr(r, ["hooks", "install", "--json"]);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({
      format: "adr-hooks/v1",
      action: "install",
      written: [],
      unchanged: SHIMS,
      registrations: REGISTRATIONS,
      snippet: null,
      trailers: [],
    });
    expect(await readFile(join(r.root, ".git/hooks/pre-commit"), "utf8")).toContain(
      '# ark-register: {"tool":"adr","argv":["hooks","run","pre-commit"]}\n',
    );
    expect(runAdr(r, ["hooks", "uninstall"]).stdout).toBe(
      SHIMS.map((s) => `removed adr from ${s}\n`).join(""),
    );
    for (const s of SHIMS) expect(existsSync(join(r.root, s))).toBe(false);
    expect(runAdr(r, ["hooks", "uninstall"]).stdout).toBe("adr hooks were not installed\n");
  });

  it("writes the other shims and exits 2 next to a foreign hook, and with core.hooksPath", async () => {
    const r = await repo();
    const foreign = join(r.root, ".git/hooks/pre-commit");
    await writeFile(foreign, "#!/bin/sh\nexit 0\n");
    const out = runAdr(r, ["hooks", "install"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(
      [
        `adr: error: ${foreign} exists and isn't an ark hook; add 'adr hooks run pre-commit' to it, or move it away and run adr hooks install again`,
        `wrote: ${SHIMS.slice(1)
          .map((s) => join(r.root, s))
          .join(", ")}`,
        "",
      ].join("\n"),
    );
    expect(await readFile(foreign, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    for (const s of SHIMS.slice(1)) expect(existsSync(join(r.root, s))).toBe(true);

    const managed = await repo();
    await git(managed, "config", "core.hooksPath", ".githooks");
    const refused = runAdr(managed, ["hooks", "install"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe(
      "adr: error: core.hooksPath is set, so another tool manages git hooks; add the commands from 'adr hooks print --manager lefthook|husky|pre-commit' to it\n",
    );
    for (const s of SHIMS) expect(existsSync(join(managed.root, s))).toBe(false);
    expect(existsSync(join(managed.root, ".githooks"))).toBe(false);
  });

  it("prints each manager's snippet, and refuses bad actions and flags with exit 2", async () => {
    const r = await repo();
    const regs = REGISTRATIONS.map((x) => ({ tool: "adr", ...x }));
    for (const manager of ["lefthook", "husky", "pre-commit"] as HookManager[]) {
      expect(runAdr(r, ["hooks", "print", "--manager", manager])).toEqual({
        status: 0,
        stdout: hookSnippet(manager, regs),
        stderr: "",
      });
    }
    expect(runAdr(r, ["hooks", "print", "--manager", "husky"]).stdout).toContain(
      '# .husky/commit-msg\nadr hooks trailers "$@"\n',
    );
    const json = JSON.parse(
      runAdr(r, ["hooks", "print", "--manager", "lefthook", "--json"]).stdout,
    );
    expect(json).toMatchObject({ action: "print", snippet: hookSnippet("lefthook", regs) });
    const error = (args: string[], message: string) =>
      expect(runAdr(r, args), args.join(" ")).toEqual({
        status: 2,
        stdout: "",
        stderr: `adr: error: ${message}\n`,
      });
    error(["hooks", "print"], "hooks print needs --manager lefthook, husky or pre-commit");
    error(
      ["hooks", "print", "--manager", "x"],
      'unknown hook manager "x"; use lefthook, husky or pre-commit',
    );
    error(["hooks", "run", "commit-msg"], "adr hooks run supports pre-commit");
    error(
      ["hooks", "x"],
      'unknown hooks action "x"; use install, uninstall, print, run or trailers',
    );
    for (const args of [
      ["hooks", "install", "extra"],
      ["hooks", "print", "extra", "--manager", "husky"],
      ["hooks", "install", "--manager", "husky"],
      ["hooks", "trailers"],
      ["hooks", "trailers", ".git/NO_SUCH_MSG"],
    ]) {
      expect(runAdr(r, args).status, args.join(" ")).toBe(2);
    }
    for (const s of SHIMS) expect(existsSync(join(r.root, s))).toBe(false);
  });

  it("rejects a commit of a tampered event and accepts a clean one with its trailers", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders");
    install(r);
    const event = (await git(r, "ls-files", `docs/adr/events/${a}`)).split("\n")[1] ?? "";
    await appendFile(join(r.root, event), "# tampered\n");
    await git(r, "add", event);
    const head = await git(r, "rev-parse", "HEAD");
    const tampered = runGit(r, ["commit", "-m", "docs: tamper"]);
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("[append-only/modified]");
    expect(await git(r, "rev-parse", "HEAD")).toBe(head);
    await git(r, "restore", "--staged", "--worktree", event);

    expect(runAdr(r, ["note", a, "Checked against the plan."]).status).toBe(0);
    const clean = runGit(r, ["commit", "-m", "docs(adr): add a note"]);
    expect(clean.status, clean.stderr).toBe(0);
    expect(await trailers(r)).toBe(`ADR: ${a}\nADR-Event: noted\n\n`);
  });

  it("stages the scoped event of a git mv in the commit, in stage mode", async () => {
    const { r, a } = await scopedRepo();
    await git(r, "mv", "src/orders", "src/billing");
    const out = runGit(r, ["commit", "-m", "refactor: move orders to billing"]);
    expect(out.status, out.stderr).toBe(0);
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).toMatch(
      new RegExp(`^docs/adr/events/${a}/\\S+-scoped\\.yaml$`, "m"),
    );
    expect(await trailers(r)).toBe(`ADR: ${a}\nADR-Event: scoped\n\n`);
    const shown = JSON.parse(runAdr(r, ["show", a, "--json"]).stdout);
    expect(shown.decision.applies_to).toEqual(["src/billing/**"]);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("stages the scoped event of a git mv in a git commit -a, which hooks see as index.lock", async () => {
    const { r, a } = await scopedRepo();
    await git(r, "mv", "src/orders", "src/billing");
    await writeFile(join(r.root, "README.md"), "changed\n");
    const out = runGit(r, ["commit", "-am", "refactor: move orders to billing"]);
    expect(out.status, out.stderr).toBe(0);
    const files = await git(r, "show", "--name-only", "--format=", "HEAD");
    expect(files).toMatch(new RegExp(`^docs/adr/events/${a}/\\S+-scoped\\.yaml$`, "m"));
    expect(files).toMatch(/^README\.md$/m);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("refuses git commit <paths> with covered renames, leaving the index as it was", async () => {
    const { r } = await scopedRepo();
    await git(r, "mv", "src/orders", "src/billing");
    const before = await git(r, "status", "--porcelain");
    const out = runGit(r, ["commit", "-m", "refactor: move", "--", "src/orders", "src/billing"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(
      'the renames in this commit change the scope of ADR-0001; git commit <paths> can\'t take the scoped events. Run adr scope --follow-renames, then commit again including the files it lists, or set [hooks] scope_follow_renames = "warn"',
    );
    expect(await git(r, "status", "--porcelain")).toBe(before);
  });

  it("only notes renames in warn mode", async () => {
    const { r } = await scopedRepo('[hooks]\nscope_follow_renames = "warn"\n');
    await git(r, "mv", "src/orders", "src/billing");
    const out = runGit(r, ["commit", "-m", "refactor: move orders to billing"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain(
      `adr: warning: ADR-0001's globs don't follow the renames in this commit (scope_follow_renames = "warn"); run adr scope --follow-renames\n`,
    );
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).not.toContain("docs/adr");
  });

  it("fails on a hand-edited index.md in check mode and regenerates it in stage mode", async () => {
    const { r } = await scopedRepo(INDEX_CONFIG);
    expect(runAdr(r, ["index", "--check"]).status).toBe(0);
    await git(r, "mv", "src/orders", "src/billing");
    const path = join(r.root, INDEX);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("[Use Aurora for orders]", "[Hand edit]"));
    await git(r, "add", INDEX);
    const stale = runGit(r, ["commit", "-m", "refactor: move orders to billing"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(
      "docs/adr/index.md is not what the tool generates; run adr index and commit it [index/stale]",
    );
    // Rename following skips the index, so the hand edit is still what is staged.
    expect(await git(r, "diff", "--cached", "--", INDEX)).toContain("+| ADR-0001 | [Hand edit]");

    await writeFile(
      join(r.root, "docs/adr/adr.toml"),
      `${INDEX_CONFIG}\n[hooks]\nindex = "stage"\n`,
    );
    await git(r, "add", "docs/adr/adr.toml");
    const staged = runGit(r, ["commit", "-m", "refactor: move orders to billing"]);
    expect(staged.status, staged.stderr).toBe(0);
    expect(staged.stderr).toContain("adr: warning: regenerated and staged docs/adr/index.md\n");
    expect((await indexCopies(r)).head).toBe(await freshIndex(r.git, "HEAD"));
    expect(runAdr(r, ["index", "--check"]).status).toBe(0);
    expect(await git(r, "status", "--porcelain")).toBe("");
  });

  it("names another decision's unstaged files in check mode, and commits without them in stage mode", async () => {
    const r = await repo({ "docs/adr/adr.toml": INDEX_CONFIG });
    await seedDecision(r, "Use Aurora");
    expect(runAdr(r, ["index", "--commit"]).status).toBe(0);
    install(r);
    // W's files are untracked, so the staged index.md (the work tree's render) lists W.
    const w = propose(r, "Use Kafka");
    const wPaths = [`docs/adr/events/${w}`, `docs/adr/decisions/${w}-use-kafka.md`];
    await git(r, "rm", "-q", "-r", "--cached", "--", ...wPaths);
    propose(r, "Use Redis");
    const files = (await git(r, "ls-files", "--others", "--", ...wPaths)).trim().split("\n").sort();
    const checked = runGit(r, ["commit", "-m", "docs(adr): propose redis"]);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain(
      `docs/adr/index.md lists decision files that aren't staged (${files.join(", ")}); git add them and commit again, or move them out of the work tree and run adr index [index/stale]`,
    );

    // Stage mode regenerates index.md from what is staged, so the commit leaves W out.
    await writeFile(
      join(r.root, "docs/adr/adr.toml"),
      `${INDEX_CONFIG}\n[hooks]\nindex = "stage"\n`,
    );
    await git(r, "add", "docs/adr/adr.toml");
    const staged = runGit(r, ["commit", "-m", "docs(adr): propose redis"]);
    expect(staged.status, staged.stderr).toBe(0);
    expect(staged.stderr).toContain("adr: warning: regenerated and staged docs/adr/index.md\n");
    const { head } = await indexCopies(r);
    expect(head).toBe(await freshIndex(r.git, "HEAD"));
    expect(head).not.toContain(w);
    expect(runAdr(r, ["verify", "--ref", "HEAD"]).status).toBe(0);
    // The work tree's copy is the staged render now; adr index brings W's entry back.
    expect(runAdr(r, ["index", "--no-commit"]).status).toBe(0);
    expect((await indexCopies(r)).worktree).toContain(w);
  });

  it("commits a proposed decision's glob for code not written yet, and says when verify checks it", async () => {
    const r = await repo();
    const p = await seedDecision(r, "Pay with Stripe", { accept: false });
    install(r);
    const out = runAdr(r, ["scope", p, "--set", "nothing/**", "--commit"]);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain(
      `adr: warning: nothing/** matches no tracked file; verify reports scope/glob-unmatched once ${p} is accepted, until a file matches\n`,
    );
  });

  it("fails adr scope --commit on an accepted decision's glob for code not written yet, with the hint", async () => {
    const r = await repo();
    const p = await seedDecision(r, "Pay with Stripe");
    install(r);
    const out = runAdr(r, ["scope", p, "--set", "nothing/**", "--commit"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(
      "adr: warning: nothing/** matches no tracked file; verify (hooks and CI) reports scope/glob-unmatched until a file matches\n",
    );
    expect(out.stderr.indexOf("adr: warning: nothing/**")).toBeLessThan(
      out.stderr.indexOf("adr: error: git commit failed"),
    );
    expect(out.stderr).toContain('scope glob "nothing/**" matches no tracked file');
    expect(out.stderr).toContain("[scope/glob-unmatched]");
    expect(out.stderr).toContain(WRITE_RERUN);
  });

  it("adds one trailer pair per decision and event type for staged events", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders");
    const b = await seedDecision(r, "Use Kafka for events");
    const c = await seedDecision(r, "Use Redis for caching");
    install(r);
    expect(runAdr(r, ["link", a, b]).status).toBe(0);
    expect(runAdr(r, ["link", a, c]).status).toBe(0);
    expect(runGit(r, ["commit", "-qm", "docs(adr): link ADR-0001"]).status).toBe(0);
    expect(await trailers(r)).toBe(`ADR: ${a}\nADR-Event: linked\n\n`);
  });

  it("adds trailers for staged events only, not to adr's own message or a merge", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders");
    install(r);
    expect(runAdr(r, ["note", a, "Own commit.", "--commit"]).status).toBe(0);
    expect(await trailers(r)).toBe(`ADR: ${a}\nADR-Event: noted\n\n`);

    expect(runGit(r, ["switch", "-q", "-c", "topic"]).status).toBe(0);
    expect(runAdr(r, ["note", a, "On a branch.", "--commit"]).status).toBe(0);
    expect(runGit(r, ["switch", "-q", "main"]).status).toBe(0);
    await writeFile(join(r.root, "README.md"), "changed\n");
    expect(runGit(r, ["commit", "-qam", "docs: change the readme"]).status).toBe(0);
    const merged = runGit(r, ["merge", "--no-ff", "-q", "-m", "Merge topic", "topic"]);
    expect(merged.status, merged.stderr).toBe(0);
    expect(await git(r, "rev-parse", "HEAD^2")).toBe(await git(r, "rev-parse", "topic"));
    expect(await trailers(r)).not.toContain("ADR");
  });

  it("verifies pushes with and without an upstream, and lists what a pull brought", async () => {
    const r = await repo();
    const a = await seedDecision(r, "Use Aurora for orders");
    install(r);
    const remote = join(dirname(r.root), "remote.git");
    expect(runGit(r, ["init", "-q", "--bare", "-b", "main", remote]).status).toBe(0);
    expect(runGit(r, ["remote", "add", "origin", remote]).status).toBe(0);
    expect(runGit(r, ["push", "-q", "-u", "origin", "main"]).status).toBe(0);
    const clone = join(dirname(r.root), "clone");
    expect(runGit(r, ["clone", "-q", remote, clone]).status).toBe(0);
    await linkAdrBin(clone);
    install(r, clone);

    const event = (await git(r, "ls-files", `docs/adr/events/${a}`)).split("\n")[0] ?? "";
    await appendFile(join(r.root, event), "# tampered\n");
    expect(runGit(r, ["commit", "-qam", "docs: tamper past the hook", "--no-verify"]).status).toBe(
      0,
    );
    const rejected = runGit(r, ["push", "-q"]);
    expect(rejected.status).not.toBe(0);
    // git runs pre-push with its stdout as is, so the findings are on stdout.
    expect(rejected.stdout).toContain("[append-only/modified]");
    expect(runGit(r, ["reset", "-q", "--hard", "@{upstream}"]).status).toBe(0);

    const b = await seedDecision(r, "Use Redis for sessions", { accept: false });
    expect(runAdr(r, ["accept", b, "--commit"]).status).toBe(0);
    expect(runGit(r, ["push", "-q"]).status).toBe(0);
    const pulled = runGit(r, ["pull", "-q", "--ff-only"], { cwd: clone });
    expect(pulled.status, pulled.stderr).toBe(0);
    // git runs post-merge with its stdout on stderr.
    expect(pulled.stderr).toMatch(/^Changed since ORIG_HEAD \([0-9a-f]{7}\):$/m);
    expect(pulled.stderr).toMatch(/^ADR-0002 .*accepted.*\n {2}\[new: (proposed, )?accepted\]$/m);

    expect(runGit(r, ["switch", "-q", "-c", "topic"]).status).toBe(0);
    expect(runAdr(r, ["note", a, "Topic branch note.", "--commit"]).status).toBe(0);
    const topic = runGit(r, ["push", "-q", "origin", "topic"]);
    expect(topic.status, topic.stderr).toBe(0);
    expect(topic.stderr).toContain(
      "adr: warning: no upstream for this branch; verifying against origin/main\n",
    );
  });
});

// Binding addendum item 1 and §4.5's earlier-uncommitted-write cases, with the hooks installed:
// adr's own --commit passes its pre-commit hook, which sees git's temporary --only index.
describe("committing writes with the hooks installed", { timeout: 120_000 }, () => {
  for (const [name, args] of [
    ["accept", (x: string) => ["accept", x]],
    ["scope", (x: string) => ["scope", x, "--set", "README.md"]],
    ["note", (x: string) => ["note", x, "A note."]],
    ["link", (x: string, z: string) => ["link", x, z]],
  ] as const) {
    it(`commits after an uncommitted adr new X, then adr ${name} X --commit`, async () => {
      const r = await repo({ "docs/adr/adr.toml": INDEX_CONFIG });
      const z = await seedDecision(r, "Use Redis");
      install(r);
      const x = propose(r, "Use Aurora");
      const out = runAdr(r, [...args(x, z), "--commit"]);
      expect(out.status, out.stderr).toBe(0);
      const { head } = await indexCopies(r);
      expect(head).toBe(await freshIndex(r.git, "HEAD"));
      expect(head).toContain(
        name === "accept"
          ? `| ADR-0002 | [Use Aurora](decisions/${x}-use-aurora.md) | accepted |`
          : `| ${x} | [Use Aurora](decisions/${x}-use-aurora.md) | proposed |`,
      );
      expect(runAdr(r, ["verify", "--ref", "HEAD"]).status).toBe(0);
      expect(await git(r, "status", "--porcelain")).toBe("");
    });
  }
});
