/**
 * The index invariant (design 2b, binding addendum after review 6): every committing write path,
 * against real temp repos, under each precondition that rounds 3–6 kept finding cases in. After
 * each write: (a) HEAD's index.md is a fresh render of HEAD's tree, (b) `adr verify --ref HEAD`
 * passes, (c) the work-tree index.md is a fresh render of the work tree, and the staged copy
 * equals it.
 */
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { openDecisionLog } from "../log.js";
import { indexDecisionLog } from "../log-index.js";
import { cliRepo, NYGARD_SECTIONS, REPO_HUMAN, runAdr, seedDecision } from "../test-support/cli.js";
import { freshIndex, INDEX, INDEX_CONFIG, indexCopies } from "../test-support/index-repo.js";
import { scopeDecision } from "../write.js";

const PATHS = [
  "new",
  "accept",
  "accept --copy-scope",
  "supersede",
  "reject",
  "withdraw",
  "deprecate",
  "note",
  "link",
  "scope",
  "init",
  "index --commit",
] as const;
type WritePath = (typeof PATHS)[number];

const PRECONDITIONS = ["others", "subject", "stale-head", "absent", "unborn", "auto"] as const;
type Precondition = (typeof PRECONDITIONS)[number];

const DESCRIBED: Record<Precondition, string> = {
  others: "other decisions have staged and unstaged-new changes",
  subject: "the subject's earlier events and body are uncommitted",
  "stale-head": "index.md is current in the work tree but stale in HEAD",
  absent: "index.md is absent",
  unborn: "HEAD is unborn",
  auto: "[policy] auto_commit = true",
};

/** Combinations that can't exist, with the reason; every other one runs. */
const SKIPS: Partial<Record<`${WritePath} / ${Precondition}`, string>> = {
  "new / subject": "a new decision has no earlier events",
  "init / subject": "init writes no events, so it has no subject",
  "index --commit / subject": "index --commit writes no events, so it has no subject",
  "init / stale-head":
    "init keeps an existing index.md and commits nothing, so HEAD's stays stale; adr index --commit is the fix",
  "accept --copy-scope / unborn":
    "copying a scope needs an accepted decision to supersede, which on an unborn HEAD is uncommitted: the subject precondition covers it",
  "supersede / unborn":
    "superseding needs two accepted decisions, which on an unborn HEAD are uncommitted: the subject precondition covers it",
  "link / unborn":
    "the link target would be uncommitted too, so HEAD would link to a decision it lacks, which the relate check reports whatever the index holds",
};

const skipOf = (path: WritePath, pre: Precondition) => SKIPS[`${path} / ${pre}`];

const FULL = Object.entries(NYGARD_SECTIONS).flatMap(([k, v]) => ["--section", `${k}=${v}`]);
const AUTO_CONFIG = `${INDEX_CONFIG}\n[policy]\nauto_commit = true\n`;

interface Case {
  readonly path: WritePath;
  /** One or more preconditions, applied together. */
  readonly pres: readonly Precondition[];
}

async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

/** Proposes (and accepts) a decision through the library; `commit: false` leaves it staged. */
async function seed(
  r: TempRepo,
  title: string,
  o: { accept?: boolean; commit: boolean; supersedes?: string[] },
): Promise<string> {
  return seedDecision(r, title, {
    accept: o.accept ?? false,
    commit: o.commit,
    ...(o.supersedes === undefined ? {} : { supersedes: o.supersedes }),
  });
}

/** Builds the repo for `c`, runs the write, and checks the invariant. */
async function runCase(c: Case): Promise<void> {
  const has = (p: Precondition) => c.pres.includes(p);
  const config = has("auto") ? AUTO_CONFIG : INDEX_CONFIG;
  const base = { "src/a.ts": "export {};\n", "docs/adr/adr.toml": config };
  const r = has("unborn") ? await createTempRepo() : await cliRepo(base);
  try {
    if (has("unborn")) {
      await r.writeFiles(base);
      await r.stage(...Object.keys(base));
    }
    const committed = !has("unborn");
    // The subject's own earlier writes: committed unless a precondition says otherwise.
    const own = committed && !has("subject");
    const z = committed ? await seed(r, "Use Postgres", { accept: true, commit: true }) : null;
    let args: string[];
    switch (c.path) {
      case "new":
        args = ["new", "Use Kafka", ...FULL, "--no-edit"];
        break;
      case "accept":
        args = ["accept", await seed(r, "Use Aurora", { commit: own })];
        break;
      case "accept --copy-scope": {
        const a = await seed(r, "Use DynamoDB", { accept: true, commit: true });
        const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
        await scopeDecision(
          log,
          { id: a, op: { set: ["src/**"] }, actor: REPO_HUMAN },
          { commit: true },
        );
        const b = await seed(r, "Use Aurora", { commit: own, supersedes: [a] });
        args = ["accept", b, "--copy-scope"];
        break;
      }
      case "supersede": {
        const a = await seed(r, "Use DynamoDB", { accept: true, commit: own });
        args = ["supersede", a, "--by", await seed(r, "Use Aurora", { accept: true, commit: own })];
        break;
      }
      case "reject":
        args = ["reject", await seed(r, "Use Aurora", { commit: own }), "--reason", "No."];
        break;
      case "withdraw":
        args = ["withdraw", await seed(r, "Use Aurora", { commit: own })];
        break;
      case "deprecate": {
        const x = await seed(r, "Use Aurora", { accept: true, commit: own });
        args = ["deprecate", x, "--reason", "Old."];
        break;
      }
      case "note":
        args = ["note", await seed(r, "Use Aurora", { commit: own }), "A note."];
        break;
      case "link":
        args = ["link", await seed(r, "Use Aurora", { commit: own }), z ?? ""];
        break;
      case "scope": {
        // On an unborn HEAD, src/a.ts is only staged, so the commit (--only) leaves it out and
        // src/** would fail verify's scope/glob-unmatched; the log's own files are committed.
        const glob = has("unborn") ? "docs/adr/**" : "src/**";
        args = ["scope", await seed(r, "Use Aurora", { commit: own }), "--set", glob];
        break;
      }
      case "init":
        args = ["init"];
        break;
      case "index --commit":
        args = ["index"];
        break;
    }
    if (has("others")) {
      await seed(r, "Use Redis", { commit: false });
      const w = await seed(r, "Use Memcached", { commit: false });
      await git(r, "rm", "-q", "-r", "--cached", "--", `docs/adr/events/${w}`);
      await git(r, "rm", "-q", "--cached", "--", `docs/adr/decisions/${w}-use-memcached.md`);
    }
    if (has("stale-head")) {
      await r.write(INDEX, "<!-- a stale index -->\n");
      await r.commit("stale index", { all: true });
      const log = await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } });
      await indexDecisionLog(log, { commit: false });
    }
    // init writes index.md only where there is none, so its index is always absent.
    if (has("absent") || c.path === "init") {
      // Dropped from HEAD, the index and the work tree; other staged work stays staged.
      await git(r, "rm", "-q", "-f", "--ignore-unmatch", "--", INDEX);
      if (committed) await git(r, "commit", "-q", "-m", "drop the index", "--", INDEX);
    }

    const before = await r.git.resolveCommit("HEAD");
    const out = runAdr(r, has("auto") ? args : [...args, "--commit"]);
    expect(out.status, `${args.join(" ")}\n${out.stderr}`).toBe(0);
    const after = await r.git.resolveCommit("HEAD");
    if (c.path !== "index --commit" && c.path !== "init") expect(after).not.toBe(before);
    const notes = out.stderr;

    // (a) and (b): HEAD's index.md is what adr renders for HEAD's tree, and verify agrees.
    const copies = await indexCopies(r);
    if (after !== null) {
      expect(copies.head, "HEAD's index.md").toBe(await freshIndex(r.git, "HEAD"));
      const verify = runAdr(r, ["verify", "--ref", "HEAD"]);
      expect(verify.status, verify.stdout).toBe(0);
    }
    // (c): the work tree's copy is a fresh render of the work tree, and the staged copy equals
    // it, because writes stage index.md from the work-tree file (design 2b D2, §4.5 steps 3 and
    // 5); or the write said why not. The staged copy is not a render of git's index: with the
    // "others" precondition, another decision's unstaged-new files are in the work tree's render
    // but not in the index, so a render of the index would leave them out.
    if (!notes.includes("index.md may be stale") && !notes.includes("index.md not updated")) {
      const worktree = await freshIndex(r.git, "worktree");
      expect(copies.worktree, "the work tree's index.md").toBe(worktree);
      expect(copies.staged, "the staged index.md").toBe(worktree);
    }
  } finally {
    await r.dispose();
  }
}

describe.concurrent("the index invariant", { timeout: 120_000 }, () => {
  for (const pre of PRECONDITIONS) {
    describe(DESCRIBED[pre], () => {
      for (const path of PATHS) {
        const skip = skipOf(path, pre);
        if (skip === undefined) it(path, () => runCase({ path, pres: [pre] }));
        else it.skip(`${path}: ${skip}`, () => {});
      }
    });
  }

  it("holds for random write paths under combined preconditions", async () => {
    // Preconditions that combine: "absent" and "stale-head" exclude each other, and "unborn"
    // stands alone (it rules out the committed seeds the others build on).
    const combinable = ["others", "subject", "auto"] as const;
    const arbCase = fc
      .record({
        path: fc.constantFrom(...PATHS),
        extra: fc.subarray([...combinable]),
        index: fc.constantFrom<Precondition | null>("stale-head", "absent", null),
      })
      .map(({ path, extra, index }) => ({
        path,
        pres: [...extra, ...(index === null ? [] : [index])].filter(
          (p) => skipOf(path, p) === undefined,
        ),
      }));
    await fc.assert(fc.asyncProperty(arbCase, runCase), { numRuns: 12 });
  });
});
