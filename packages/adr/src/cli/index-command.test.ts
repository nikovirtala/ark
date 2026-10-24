import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommitFailedError, type EventEnvelope } from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type DecisionLog, openDecisionLog } from "../log.js";
import { INDEX_BEFORE } from "../log-index.js";
import {
  CLI,
  cliRepo,
  hintCommand,
  NYGARD_SECTIONS,
  REPO_HUMAN,
  runAdr,
  runShell,
  seedDecision,
} from "../test-support/cli.js";
import { decisionEvent, eventFile } from "../test-support/events.js";
import {
  freshIndex,
  INDEX,
  INDEX_CONFIG,
  indexCopies,
  shallowClone,
} from "../test-support/index-repo.js";
import { acceptDecision, applyPlan, proposeDecision, type WriteDeps } from "../write.js";

const repos: TempRepo[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
  for (const c of cleanups.splice(0)) await c();
});
async function repo(...args: Parameters<typeof cliRepo>): Promise<TempRepo> {
  const r = await cliRepo(...args);
  repos.push(r);
  return r;
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
const head = async (r: TempRepo) => (await git(r, "rev-parse", "HEAD")).trim();
const porcelain = (r: TempRepo) => git(r, "status", "--porcelain", "--untracked-files=all");
const open = (r: TempRepo): Promise<DecisionLog> =>
  openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });

/** A log with an accepted decision committed before `[log] index = "committed"`: no index yet. */
async function seeded(config = INDEX_CONFIG): Promise<{ r: TempRepo; x: string }> {
  const r = await repo();
  const x = await seedDecision(r, "Use Aurora");
  await r.write("docs/adr/adr.toml", config);
  await r.stage("docs/adr/adr.toml");
  await r.commit("turn the index on");
  return { r, x };
}

/** `seeded()` with its index committed. */
async function indexed(config = INDEX_CONFIG): Promise<{ r: TempRepo; x: string }> {
  const s = await seeded(config);
  expect(runAdr(s.r, ["index", "--commit"]).status).toBe(0);
  return s;
}

const verify = (r: TempRepo, ...args: string[]) => runAdr(r, ["verify", ...args]).status;

describe("adr index", { timeout: 60_000 }, () => {
  it("writes and stages index.md, then reports it up to date", async () => {
    const { r, x } = await seeded();
    expect(runAdr(r, ["index"])).toEqual({
      status: 0,
      stdout: "Wrote docs/adr/index.md\n",
      stderr: "",
    });
    const copies = await indexCopies(r);
    expect(copies.worktree).toBe(await freshIndex(r.git, "worktree"));
    expect(copies.staged).toBe(copies.worktree);
    expect(copies.worktree).toContain(`| ADR-0001 | [Use Aurora](decisions/${x}-use-aurora.md) |`);
    expect(runAdr(r, ["index"]).stdout).toBe("docs/adr/index.md is up to date\n");
    expect(JSON.parse(runAdr(r, ["index", "--json"]).stdout)).toEqual({
      format: "adr-index/v1",
      path: INDEX,
      check: false,
      fresh: true,
      written: [],
      commit: null,
      findings: [],
      notes: [],
    });
  });

  it("checks index.md with --check: fresh, stale and missing", async () => {
    const { r } = await seeded();
    const missing = runAdr(r, ["index", "--check"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("[index/missing]");
    expect(runAdr(r, ["index", "--commit"]).status).toBe(0);
    expect(runAdr(r, ["index", "--check"])).toEqual({
      status: 0,
      stdout: "docs/adr/index.md is up to date\n",
      stderr: "",
    });
    const text = await readFile(join(r.root, INDEX), "utf8");
    await r.write(INDEX, text.replace("[Use Aurora]", "[Use Aurora, edited]"));
    const stale = runAdr(r, ["index", "--check"]);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain(
      "docs/adr/index.md: error: docs/adr/index.md is not what the tool generates; run adr index and commit it [index/stale]",
    );
    expect(runAdr(r, ["--ref", "HEAD", "index", "--check"]).status).toBe(0);
    await r.remove(INDEX);
    const gone = runAdr(r, ["index", "--check", "--json"]);
    expect(gone.status).toBe(1);
    expect(JSON.parse(gone.stdout).findings.map((f: { rule: string }) => f.rule)).toEqual([
      "index/missing",
    ]);
  });

  it("commits index.md alone with a conventional subject and no trailers", async () => {
    const { r } = await seeded();
    await r.write("other.txt", "o\n");
    await r.stage("other.txt");
    const out = runAdr(r, ["index", "--commit"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^Committed docs\/adr\/index\.md as [0-9a-f]{7}\n$/);
    expect(await git(r, "log", "-1", "--format=%B")).toBe(
      "docs(adr): regenerate the decision index\n\n",
    );
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).toBe(`${INDEX}\n`);
    expect(await git(r, "diff", "--cached", "--name-only")).toBe("other.txt\n");
    expect(verify(r, "--ref", "HEAD")).toBe(0);
    const before = await head(r);
    expect(runAdr(r, ["index", "--commit"]).stdout).toBe("docs/adr/index.md is up to date\n");
    expect(await head(r)).toBe(before);
  });

  it("commits what adr index wrote with index --commit", async () => {
    const { r } = await seeded();
    expect(runAdr(r, ["index"]).status).toBe(0);
    const out = runAdr(r, ["index", "--commit", "--json"]);
    expect(JSON.parse(out.stdout)).toMatchObject({
      fresh: false,
      written: [],
      commit: await head(r),
    });
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).toBe(`${INDEX}\n`);
    expect(verify(r, "--ref", "HEAD")).toBe(0);
    expect(await porcelain(r)).toBe("");
  });

  it("leaves other decisions' uncommitted entries in the work tree when HEAD's is current", async () => {
    const { r } = await indexed();
    const y = await seedDecision(r, "Use Redis", { accept: false, commit: false });
    const before = await head(r);
    expect(runAdr(r, ["index", "--commit"]).stdout).toBe("docs/adr/index.md is up to date\n");
    expect(await head(r)).toBe(before);
    let copies = await indexCopies(r);
    expect(copies.worktree).toContain(y);
    expect(copies.staged).toBe(copies.worktree);
    expect(verify(r, "--staged")).toBe(0);

    // A hand edit of the work tree's copy: HEAD's is still current, so step 5 restores it.
    await r.write(INDEX, "hand edit\n");
    expect(runAdr(r, ["index", "--commit"]).stdout).toBe(
      "docs/adr/index.md is up to date in HEAD; wrote the work tree's copy, which includes uncommitted log changes\n",
    );
    expect(await head(r)).toBe(before);
    copies = await indexCopies(r);
    expect(copies.worktree).toBe(await freshIndex(r.git, "worktree"));
    expect(copies.staged).toBe(copies.worktree);
  });

  it("commits the index of HEAD plus the batch, and restores the others' entries after", async () => {
    const { r } = await indexed();
    const x = await seedDecision(r, "Use DynamoDB", { accept: false });
    const y = await seedDecision(r, "Use Redis", { accept: false, commit: false });

    // scope doesn't change the index: index.md stays out of the commit, and Y stays listed.
    const before = await indexCopies(r);
    expect(runAdr(r, ["scope", x, "--set", "README.md", "--commit"]).status).toBe(0);
    expect(await git(r, "show", "--name-only", "--format=", "HEAD")).not.toContain(INDEX);
    const after = await indexCopies(r);
    expect([after.worktree, after.staged]).toEqual([before.worktree, before.staged]);
    expect(after.worktree).toContain(y);
    expect(verify(r, "--staged")).toBe(0);

    const out = runAdr(r, ["accept", x, "--commit", "--json"]);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).written).toContain(INDEX);
    const copies = await indexCopies(r);
    expect(copies.head).toMatch(
      new RegExp(
        `\\| ADR-0002 \\| \\[Use DynamoDB\\]\\(decisions/${x}-use-dynamodb\\.md\\) \\| accepted \\|`,
      ),
    );
    expect(copies.head).not.toContain(y);
    expect(copies.worktree).toContain(y);
    expect(copies.worktree).toContain("ADR-0002");
    expect(copies.staged).toBe(copies.worktree);
    expect(verify(r, "--ref", "HEAD")).toBe(0);
    expect(verify(r, "--staged")).toBe(0);
  });

  it("numbers only the committed acceptance while another one is staged", async () => {
    const { r } = await indexed();
    const x = await seedDecision(r, "Use DynamoDB", { accept: false });
    const w = await seedDecision(r, "Use Redis", { accept: false });
    const log = await open(r);
    expect((await acceptDecision(log, { id: w, actor: REPO_HUMAN }, { commit: false })).ok).toBe(
      true,
    );
    expect(runAdr(r, ["accept", x, "--commit"]).status).toBe(0);
    const copies = await indexCopies(r);
    expect(copies.head).toContain(`| ADR-0002 | [Use DynamoDB]`);
    expect(copies.head).toMatch(new RegExp(`\\| ${w} \\| \\[Use Redis\\]\\S+ \\| proposed \\|`));
    expect(copies.worktree).toContain("| ADR-0003 | [Use Redis]");
    expect(copies.staged).toBe(copies.worktree);
    expect(verify(r, "--ref", "HEAD")).toBe(0);
    expect(verify(r, "--staged")).toBe(0);
  });

  it("fails a plain git commit's verify hook while another decision's files are untracked", async () => {
    // Writes stage index.md from the work-tree file (D2), so with W's files untracked the staged
    // index lists W while git's index lacks it. `adr hooks` arrives later; this hook runs ledger's
    // default pre-commit command, `verify --staged`, which is what check mode verifies.
    const { r } = await indexed();
    const w = await seedDecision(r, "Use Kafka", { accept: false, commit: false });
    const wPaths = [`docs/adr/events/${w}`, `docs/adr/decisions/${w}-use-kafka.md`];
    await git(r, "rm", "-q", "-r", "--cached", "--", ...wPaths);
    await writeFile(
      join(r.git.gitDir, "hooks", "pre-commit"),
      `#!/bin/sh\nexec "${process.execPath}" "${CLI}" verify --staged\n`,
      { mode: 0o755 },
    );
    await seedDecision(r, "Use Redis", { accept: false, commit: false });
    const commit = () =>
      r.git.run(["commit", "-q", "-m", "docs: propose redis"], { okCodes: [0, 1] });
    // The finding names W's files: staging them is the fix, and adr index changes nothing.
    const files = (await git(r, "ls-files", "--others", "--", ...wPaths)).trim().split("\n").sort();
    const stale = `docs/adr/index.md: error: docs/adr/index.md lists decision files that aren't staged (${files.join(", ")}); git add them and commit again, or move them out of the work tree and run adr index [index/stale]`;
    const first = await commit();
    expect(first.code).toBe(1);
    expect(Buffer.from(first.stderr).toString()).toContain(stale);

    // adr index renders the work tree, which holds W, so it changes nothing while W is untracked.
    expect(runAdr(r, ["index"]).stdout).toBe("docs/adr/index.md is up to date\n");
    const again = await commit();
    expect(again.code).toBe(1);
    expect(Buffer.from(again.stderr).toString()).toContain(stale);

    await r.stage(...wPaths);
    expect((await commit()).code).toBe(0);
    expect(verify(r, "--ref", "HEAD")).toBe(0);
    expect(await porcelain(r)).toBe("");

    // A hand edit, with nothing unstaged, keeps the finding's usual fix.
    const text = await readFile(join(r.root, INDEX), "utf8");
    await writeFile(join(r.root, INDEX), text.replace("[Use Kafka]", "[Use Pulsar]"));
    await r.stage(INDEX);
    const edited = await commit();
    expect(edited.code).toBe(1);
    expect(Buffer.from(edited.stderr).toString()).toContain(
      "docs/adr/index.md: error: docs/adr/index.md is not what the tool generates; run adr index and commit it [index/stale]",
    );
  });

  it("exits 2 for a log without a committed index and for conflicting flags", async () => {
    const r = await repo();
    const cases: [string[], string][] = [
      [["index"], 'adr index needs [log] index = "committed" in adr.toml'],
      [["index", "--check", "--commit"], "--check writes nothing; drop --commit and --message"],
      [["index", "--check", "-m", "x"], "--check writes nothing; drop --commit and --message"],
      [["--ref", "HEAD", "index"], "adr index writes the work tree; use --ref only with --check"],
    ];
    for (const [args, message] of cases) {
      const out = runAdr(r, ["--json", ...args]);
      expect(out.status, args.join(" ")).toBe(2);
      expect(JSON.parse(out.stdout).error.message).toBe(message);
    }
    expect(await porcelain(r)).toBe("");
  });

  it("reports index/unchecked in a shallow clone without recorded numbers", async () => {
    const { r } = await indexed();
    // A committed index whose numbers line is gone records nothing.
    const text = await readFile(join(r.root, INDEX), "utf8");
    await r.write(INDEX, text.replace(/<!-- ledger-index\/v1 numbers:.*-->\n$/, ""));
    await r.commit("drop the numbers", { all: true });
    const clone = await shallowClone(r);
    cleanups.push(clone.dispose);
    const check = runAdr(r, ["index", "--check"], { cwd: clone.root });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(
      "docs/adr/index.md: warning: docs/adr/index.md can't be checked here: numbers need history in a shallow clone without a recorded index; run git fetch --unshallow [index/unchecked]",
    );
    const write = runAdr(r, ["index"], { cwd: clone.root });
    expect(write.status).toBe(2);
    expect(write.stderr).toBe(
      "adr: error: numbers need history in this shallow clone; run git fetch --unshallow\n",
    );
    await writeFile(
      join(clone.root, "docs/adr/adr.toml"),
      `${INDEX_CONFIG}\n[verify]\nfail_on = "warning"\n`,
    );
    expect(runAdr(r, ["index", "--check"], { cwd: clone.root }).status).toBe(1);
  });

  it("names the index under a --root log in its texts", async () => {
    const r = await repo({ "adr.toml": '[log]\nroot = "decisions"\n' });
    await seedDecision(r, "Use Aurora", { accept: false });
    await r.write("adr.toml", '[log]\nroot = "decisions"\nindex = "committed"\n');
    await r.commit("turn the index on", { all: true });
    const clone = await shallowClone(r);
    cleanups.push(clone.dispose);
    const shallow = runAdr(
      r,
      [
        "new",
        "Use Redis",
        ...Object.entries(NYGARD_SECTIONS).flatMap(([k, v]) => ["--section", `${k}=${v}`]),
      ],
      { cwd: clone.root },
    );
    expect(shallow.status).toBe(0);
    expect(shallow.stderr).toBe(
      "adr: warning: decisions/index.md not updated: numbers need history in this shallow clone; run git fetch --unshallow, then adr index\n",
    );
    expect(runAdr(r, ["index"]).stdout).toBe("Wrote decisions/index.md\n");
    expect(await freshIndex(r.git, "worktree", "decisions")).toBe(
      await readFile(join(r.root, "decisions/index.md"), "utf8"),
    );
  });

  it("refuses a write when index.md can't be replaced, leaving nothing behind", async () => {
    const { r } = await seeded();
    // As root a read-only file can still be replaced, so a directory stands in for it.
    await mkdir(join(r.root, INDEX), { recursive: true });
    await writeFile(join(r.root, INDEX, "keep"), "x\n");
    const out = runAdr(r, ["new", "Use Redis", "--no-edit"]);
    expect(out.status).toBe(2);
    expect(await porcelain(r)).toBe(`?? ${INDEX}/keep\n`);
    expect(await readFile(join(r.root, INDEX, "keep"), "utf8")).toBe("x\n");
  });
});

type Render = NonNullable<Parameters<typeof applyPlan>[2]["index"]>;
type Plan = Parameters<typeof applyPlan>[1];

/** An `apply` that runs `applyPlan` with `o.index` replaced by `index(real)`, and more options. */
function withIndex(
  index: (real: Render) => Render,
  more: Partial<Parameters<typeof applyPlan>[2]> = {},
  plan: (p: Plan) => Plan = (p) => p,
): WriteDeps {
  return {
    now: Date.now,
    apply: (log, p, o) => {
      const real = o.index;
      if (real === undefined) throw new Error("the log has no committed index");
      return applyPlan(log, plan(p), { ...o, index: index(real), ...more });
    },
  };
}

const boom = () => new Error("boom\nsecond line");
/** The real render on the first call, a throw on every later one. */
const secondFails =
  (real: Render): Render =>
  async (tree, history) => {
    calls.n += 1;
    if (calls.n === 1) return real(tree, history);
    throw boom();
  };
const calls = { n: 0 };

/** A `noted` event of `id` that sorts after the write's own events. */
function lateNote(id: string): EventEnvelope {
  const at = new Date(Date.now() + 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return decisionEvent(id, "noted", { data: { text: "Late." }, at });
}

describe("writes with an injected index failure", { timeout: 60_000 }, () => {
  afterEach(() => {
    calls.n = 0;
  });

  it("writes nothing when the first render fails", async () => {
    const { r } = await indexed();
    const deps = withIndex(() => async () => {
      throw boom();
    });
    const log = await open(r);
    await expect(
      proposeDecision(
        log,
        { title: "Use Redis", sections: NYGARD_SECTIONS, actor: REPO_HUMAN },
        { commit: true },
        deps,
      ),
    ).rejects.toThrow("boom");
    expect(await porcelain(r)).toBe("");
  });

  for (const auto of [false, true]) {
    it(`gives the couldn't-be-refreshed hint when the second render fails${auto ? " (auto_commit)" : ""}`, async () => {
      const config = auto ? `${INDEX_CONFIG}\n[policy]\nauto_commit = true\n` : INDEX_CONFIG;
      const { r } = await indexed(config);
      const x = await seedDecision(r, "Use DynamoDB", { accept: false });
      const before = await head(r);
      const [notePath, noteText] = eventFile(lateNote(x));
      // The editor step stages another event of the subject, so the extras change.
      const deps = withIndex(secondFails, {
        afterStage: async () => {
          await r.write(notePath, noteText);
          await r.stage(notePath);
          return { findings: null, commit: true };
        },
      });
      const e = await acceptDecision(
        await open(r),
        { id: x, actor: REPO_HUMAN },
        auto ? {} : { commit: true },
        deps,
      ).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(CommitFailedError);
      const message = (e as CommitFailedError).message;
      expect(message.split("\n")[0]).toBe("docs/adr/index.md couldn't be refreshed: boom");
      expect(message).toContain(`\n${INDEX_BEFORE("docs/adr")}\n`);
      expect(message).toContain(`  ${notePath}\n`);
      expect(message).toContain(`  ${INDEX}\n`);
      const recovery = (e as CommitFailedError).recovery;
      expect(await readFile(recovery.messageFile, "utf8")).toContain("ADR-Event: noted");
      expect(await head(r)).toBe(before);

      expect(runAdr(r, ["index", "--no-commit"]).status).toBe(0);
      expect(await head(r)).toBe(before);
      expect(runShell(r, hintCommand(message)).status).toBe(0);
      expect(await head(r)).not.toBe(before);
      expect(verify(r, "--ref", "HEAD")).toBe(0);
      expect(await porcelain(r)).toBe("");
    });
  }

  it("keeps a write whose commit the editor step turned off, with a may-be-stale note", async () => {
    const { r } = await indexed();
    const x = await seedDecision(r, "Use DynamoDB", { accept: false });
    const before = await head(r);
    const deps = withIndex(secondFails, {
      afterStage: async () => ({ findings: null, commit: false }),
    });
    const doc = await acceptDecision(
      await open(r),
      { id: x, actor: REPO_HUMAN },
      { commit: true },
      deps,
    );
    expect(doc).toMatchObject({ ok: true, commit: null });
    expect(doc.notes).toContain("docs/adr/index.md may be stale: boom; run adr index");
    expect(await head(r)).toBe(before);
  });

  it("keeps the commit when the refresh after it fails, with a may-be-stale note", async () => {
    const { r } = await indexed();
    const x = await seedDecision(r, "Use DynamoDB", { accept: false });
    const start = await head(r);
    const deps = withIndex((real) => async (tree, history) => {
      if (history !== start) throw boom();
      return real(tree, history);
    });
    const doc = await acceptDecision(
      await open(r),
      { id: x, actor: REPO_HUMAN },
      { commit: true },
      deps,
    );
    expect(doc.commit).toBe(await head(r));
    expect(doc.notes).toContain("docs/adr/index.md may be stale: boom; run adr index");
    expect(verify(r, "--ref", "HEAD")).toBe(0);
  });

  it("restores index.md when writing the events fails after it", async () => {
    // A noted event without its text fails validation in writeEvents, after index.md is written.
    const broken = (p: Plan): Plan => {
      const [first] = p.events;
      if (first === undefined) throw new Error("no events");
      return { ...p, events: [...p.events, { ...lateNote(first.subject), data: {} }] };
    };
    const real = withIndex((idx) => idx, {}, broken);

    const { r } = await indexed();
    const before = await indexCopies(r);
    const log = await open(r);
    const input = { title: "Use Redis", sections: NYGARD_SECTIONS, actor: REPO_HUMAN };
    await expect(proposeDecision(log, input, {}, real)).rejects.toThrow(/invalid event/);
    expect(await indexCopies(r)).toEqual(before);
    expect(await porcelain(r)).toBe("");

    const fresh = await seeded();
    await expect(proposeDecision(await open(fresh.r), input, {}, real)).rejects.toThrow(
      /invalid event/,
    );
    expect(await porcelain(fresh.r)).toBe("");
  });
});
