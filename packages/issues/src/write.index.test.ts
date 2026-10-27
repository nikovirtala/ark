/**
 * The index × `--commit` invariant (design addendum §6.3, §9.1): every committing write, crossed
 * with the preconditions below, leaves HEAD's `index.md` equal to HEAD's render, `verify --ref
 * HEAD` clean, the work-tree and staged copies current (or a documented note), and nothing it
 * wrote unstaged. In-process through the library writes, which the CLI calls with the same
 * options; `cli/index-invariant.test.ts` runs one row per precondition with the built binary.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Actor,
  type EventEnvelope,
  type Finding,
  indexReader,
  refReader,
  worktreeReader,
} from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { AppliedPlan } from "./apply.js";
import { applyPlan } from "./apply.js";
import { initIssueLog } from "./init.js";
import { type IssueLog, openIssueLog, readIssues } from "./log.js";
import { indexIssueLog, renderIssueIndex } from "./log-index.js";
import { REPO_HUMAN } from "./test-support/cli.js";
import { verifyIssues } from "./verify.js";
import {
  assignIssue,
  closeIssue,
  commentIssue,
  type Editor,
  editIssue,
  followScopeRenames,
  type IssueWriteJson,
  labelIssue,
  linkIssue,
  openIssue,
  reopenIssue,
  scopeIssue,
  startIssue,
  stopIssue,
  unlinkIssue,
  type WriteDeps,
  type WriteOptions,
} from "./write.js";

const ROOT = "docs/issues";
const INDEX = `${ROOT}/index.md`;
const CONFIG = '[log]\nindex = "committed"\n';
const SECTIONS = { goal: "Do the thing.", done: "The thing is done." };
const me: Actor = REPO_HUMAN;

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

const open = (r: TempRepo) => openIssueLog({ cwd: r.root, gitOptions: { env: r.env } });
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

/** Opens an issue through the library; `commit` false leaves it staged. */
async function newIssue(r: TempRepo, title: string, commit: boolean): Promise<string> {
  const doc = await openIssue(await open(r), { title, sections: SECTIONS, actor: me }, { commit });
  if (!doc.ok || doc.issue === null) throw new Error(`can't open ${title}`);
  return doc.issue.id;
}

/** An editor that leaves the file, or one that changes its `# ` heading. */
const keep: Editor = async () => null;
const retitle =
  (title: string): Editor =>
  async (abs) => {
    const text = await readFile(abs, "utf8");
    await writeFile(abs, text.replace(/^# .*$/m, `# ${title}`));
    return null;
  };

type Pre = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
const PRECONDITIONS: Readonly<Record<Pre, string>> = {
  1: "other issues have uncommitted changes, staged and unstaged-new",
  2: "the subject's earlier events and description are uncommitted",
  3: "the write reaches an issue not in HEAD",
  4: "the subject's description has a staged retitle",
  5: "index.md is current in the work tree but stale in HEAD",
  6: "index.md is absent",
  7: "HEAD is unborn",
  8: "auto_commit = true, no --commit",
};

interface Ctx {
  readonly r: TempRepo;
  /** The subject the write works on. */
  readonly x: string;
  /** Another committed issue, for link, duplicate and assign targets. */
  readonly other: string;
  /** Whether prep steps commit (false for precondition 2 and 7). */
  readonly commit: boolean;
}

/** One committing write: `prep` brings the subject into the state the write needs. */
interface Row {
  readonly name: string;
  readonly prep?: (c: Ctx, o: WriteOptions) => Promise<unknown>;
  readonly run: (c: Ctx, o: WriteOptions) => Promise<IssueWriteJson | null>;
  /** Preconditions that don't apply, with why. */
  readonly skip?: Partial<Record<Pre, string>>;
  /** The new title the write gives the subject, checked in HEAD's index. */
  readonly newTitle?: string;
  /** The write commits only when HEAD's copy differs (index --commit). */
  readonly mayNotCommit?: boolean;
}

const ROWS: readonly Row[] = [
  {
    name: "new",
    run: async (c, o) =>
      openIssue(await open(c.r), { title: "A new issue", sections: SECTIONS, actor: me }, o),
  },
  {
    name: "new --edit (draft kept)",
    run: async (c, o) =>
      openIssue(
        await open(c.r),
        { title: "A drafted issue", sections: SECTIONS, actor: me },
        { ...o, edit: keep },
      ),
  },
  {
    name: "new --edit (heading changed)",
    newTitle: "Renamed in the editor",
    run: async (c, o) =>
      openIssue(
        await open(c.r),
        { title: "A drafted issue", sections: SECTIONS, actor: me },
        { ...o, edit: retitle("Renamed in the editor") },
      ),
  },
  {
    name: "edit --title",
    newTitle: "Edited title",
    run: async (c, o) => editIssue(await open(c.r), { id: c.x, title: "Edited title" }, o),
  },
  {
    name: "edit --section",
    run: async (c, o) =>
      editIssue(await open(c.r), { id: c.x, sections: { goal: "Do it better." } }, o),
  },
  {
    name: "edit (editor)",
    run: async (c, o) => {
      const edit: Editor = async (abs) => {
        await writeFile(abs, `${await readFile(abs, "utf8")}\nMore detail.\n`);
        return null;
      };
      return editIssue(await open(c.r), { id: c.x }, { ...o, edit });
    },
  },
  {
    name: "edit (editor, heading changed)",
    newTitle: "Retitled in the editor",
    run: async (c, o) =>
      editIssue(await open(c.r), { id: c.x }, { ...o, edit: retitle("Retitled in the editor") }),
  },
  { name: "start", run: async (c, o) => startIssue(await open(c.r), { id: c.x, actor: me }, o) },
  {
    name: "stop",
    prep: async (c, o) => startIssue(await open(c.r), { id: c.x, actor: me }, o),
    run: async (c, o) => stopIssue(await open(c.r), { id: c.x, actor: me }, o),
  },
  { name: "close", run: async (c, o) => closeIssue(await open(c.r), { id: c.x, actor: me }, o) },
  {
    name: "close --resolution wontfix",
    run: async (c, o) =>
      closeIssue(
        await open(c.r),
        { id: c.x, resolution: "wontfix", reason: "Not needed.", actor: me },
        o,
      ),
  },
  {
    name: "close --duplicate-of",
    run: async (c, o) =>
      closeIssue(
        await open(c.r),
        { id: c.x, resolution: "duplicate", of: c.other, reason: "Same work.", actor: me },
        o,
      ),
  },
  {
    name: "reopen",
    prep: async (c, o) => closeIssue(await open(c.r), { id: c.x, actor: me }, o),
    run: async (c, o) =>
      reopenIssue(await open(c.r), { id: c.x, reason: "Not done after all.", actor: me }, o),
  },
  {
    name: "assign",
    run: async (c, o) =>
      assignIssue(await open(c.r), { id: c.x, op: { add: ["ada@example.com"] }, actor: me }, o),
  },
  {
    name: "label",
    run: async (c, o) =>
      labelIssue(await open(c.r), { id: c.x, op: { add: ["type:bug"] }, actor: me }, o),
  },
  {
    name: "comment",
    run: async (c, o) =>
      commentIssue(await open(c.r), { id: c.x, text: "A comment.", actor: me }, o),
  },
  {
    name: "link",
    run: async (c, o) =>
      linkIssue(await open(c.r), { id: c.x, to: c.other, rel: "depends-on", actor: me }, o),
  },
  {
    name: "unlink",
    prep: async (c, o) =>
      linkIssue(await open(c.r), { id: c.x, to: c.other, rel: "relates-to", actor: me }, o),
    run: async (c, o) =>
      unlinkIssue(await open(c.r), { id: c.x, to: c.other, rel: "relates-to", actor: me }, o),
  },
  {
    name: "scope",
    run: async (c, o) =>
      scopeIssue(await open(c.r), { id: c.x, op: { set: ["README.md"] }, actor: me }, o),
  },
  {
    name: "scope --follow-renames, then git commit",
    skip: {
      1: "a plain git commit with an unstaged new issue is the pre-commit hook's case",
      7: "an unborn HEAD has no renames",
    },
    prep: async (c, o) =>
      scopeIssue(await open(c.r), { id: c.x, op: { set: ["README.md"] }, actor: me }, o),
    run: async (c) => {
      await git(c.r, "mv", "README.md", "READ-ME.md");
      const doc = await followScopeRenames(await open(c.r), { id: c.x, actor: me });
      expect(doc.affected.map((v) => v.applies_to)).toEqual([["READ-ME.md"]]);
      await git(c.r, "commit", "-qm", "docs: rename the readme");
      return { ...doc, commit: await c.r.git.resolveCommit("HEAD") };
    },
  },
  {
    name: "init",
    skip: {
      1: "init on an existing log writes nothing",
      2: "init on an existing log writes nothing",
      3: "init on an existing log writes nothing",
      4: "init on an existing log writes nothing",
      5: "init on an existing log writes nothing",
      8: "init on an existing log writes nothing",
    },
    run: async (c, o) => {
      const doc = await initIssueLog(await open(c.r), {
        ...(o.commit === undefined ? {} : { commit: o.commit }),
      });
      return { ok: true, commit: doc.commit, notes: doc.notes, written: doc.written } as never;
    },
  },
  {
    name: "index --commit",
    mayNotCommit: true,
    run: async (c, o) => {
      const doc = await indexIssueLog(await open(c.r), o);
      return { ok: true, commit: doc.commit, notes: doc.notes, written: doc.written } as never;
    },
  },
];

/** The staged entries (`git ls-files -s`) by path. */
async function stagedBlobs(r: TempRepo): Promise<Map<string, string>> {
  const out = await git(r, "ls-files", "-s");
  return new Map(
    out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [meta = "", path = ""] = l.split("\t");
        return [path, meta];
      }),
  );
}

/** Sets up a repository in precondition `pre`; returns the context for the write. */
async function arrange(pre: Pre, row: Row): Promise<{ c: Ctx; o: WriteOptions }> {
  const config = pre === 8 ? `${CONFIG}\n[policy]\nauto_commit = true\n` : CONFIG;
  const unborn = pre === 7;
  const r = await createTempRepo(
    unborn ? {} : { files: { "README.md": "readme\n", [`${ROOT}/issues.toml`]: config } },
  );
  repos.push(r);
  const commit = !unborn;
  if (unborn) {
    await r.write(`${ROOT}/issues.toml`, config);
    await r.stage(`${ROOT}/issues.toml`);
  }
  if (row.name !== "init" || pre !== 7) {
    await initIssueLog(await open(r), { commit });
  }
  if (row.name === "init" && unborn) {
    // init in an unborn repository: only the config, staged.
    return { c: { r, x: "", other: "", commit: false }, o: { commit: true } };
  }
  const other = await newIssue(r, "Another issue", commit);
  const subjectCommitted = pre !== 2 && !unborn;
  const x = await newIssue(r, "The subject", subjectCommitted);
  const c: Ctx = { r, x, other, commit: subjectCommitted };
  if (row.prep !== undefined) await row.prep(c, { commit: subjectCommitted });
  switch (pre) {
    case 1: {
      await newIssue(r, "Staged other", false);
      await newIssue(r, "Unstaged other", false);
      const staged = await stagedBlobs(r);
      const head = await git(r, "ls-tree", "-r", "--name-only", "HEAD");
      const fresh = [...staged.keys()].filter(
        (p) => p.includes("unstaged-other") && !head.includes(p),
      );
      if (fresh.length > 0) await git(r, "rm", "-q", "--cached", "--", ...fresh);
      break;
    }
    case 3: {
      const y = await newIssue(r, "Not yet in HEAD", false);
      await linkIssue(await open(r), { id: x, to: y, rel: "relates-to", actor: me }, {});
      break;
    }
    case 4: {
      const view = (await readIssues(await open(r))).projection.views.get(x);
      const path = view?.body_path ?? "";
      const text = await readFile(join(r.root, path), "utf8");
      await writeFile(join(r.root, path), text.replace(/^# .*$/m, "# Retitled, staged"));
      await r.stage(path);
      break;
    }
    case 5: {
      await openIssue(
        await open(r),
        { title: "Committed without the index", sections: SECTIONS, actor: me },
        { commit: true, index: "skip" },
      );
      await indexIssueLog(await open(r), { commit: false });
      break;
    }
    case 6: {
      await git(r, "rm", "-q", "--", INDEX);
      await git(r, "commit", "-qm", "chore: drop the index");
      break;
    }
    default:
      break;
  }
  return { c, o: pre === 8 ? {} : { commit: true } };
}

/** HEAD's commit and the paths it changed. */
async function headChange(r: TempRepo): Promise<string[]> {
  return (await git(r, "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean);
}

/** Invariants (a)–(d) of §6.3 after a committing write. */
async function assertInvariants(
  r: TempRepo,
  doc: {
    readonly commit: string | null;
    readonly notes: readonly string[];
    readonly written: readonly string[];
  },
  before: Map<string, string>,
  newTitle?: string,
  /** `issues index` stages the work tree's render (design 2b D2) and adds no note. */
  worktreeStaged = false,
): Promise<void> {
  const log = await open(r);
  const head = (await r.git.resolveCommit("HEAD")) ?? "";
  const render = (tree: Parameters<typeof renderIssueIndex>[1]["tree"]) =>
    renderIssueIndex(r.git, { layout: log.layout, issues: log.issues, tree, history: head });
  const headTree = await refReader(r.git, head);
  const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));
  // (a) HEAD's index.md is HEAD's render.
  const inHead = text(await headTree.read(INDEX));
  expect(inHead, "HEAD's index.md").toBe(await render(headTree));
  if (newTitle !== undefined) expect(inHead).toContain(newTitle);
  // (b) verify --ref HEAD finds no error.
  const atHead = await openIssueLog({ cwd: r.root, ref: "HEAD", gitOptions: { env: r.env } });
  const errors = (await verifyIssues(atHead, { type: "full", head: "HEAD" })).filter(
    (f: Finding) => f.severity === "error",
  );
  expect(errors.map((f) => `${f.rule} ${f.message}`)).toEqual([]);
  // (c) the work-tree and staged copies are current, or a documented note says why not.
  const noted = doc.notes.some((n) =>
    /index\.md (not updated|may be stale|lists issue files that aren't staged)/.test(n),
  );
  const wt = text(await worktreeReader(r.git).read(INDEX));
  expect(wt, "work-tree index.md").toBe(await render(worktreeReader(r.git)));
  const idx = await indexReader(r.git);
  const staged = text(await idx.read(INDEX));
  if (!noted) {
    const want = await render(idx);
    if (worktreeStaged && staged !== want) expect(staged, "staged index.md").toBe(wt);
    else expect(staged, "staged index.md").toBe(want);
  }
  // (d) nothing it wrote is unstaged; other staged paths outside the commit kept their bytes.
  const unstaged = new Set(await r.git.unstagedPaths([ROOT]));
  for (const p of doc.written) expect(unstaged.has(p), `${p} unstaged`).toBe(false);
  const changed = new Set(await headChange(r));
  const after = await stagedBlobs(r);
  for (const [p, meta] of before) {
    if (changed.has(p) || p === INDEX) continue;
    expect(after.get(p), `${p} kept staged`).toBe(meta);
  }
}

describe("index × --commit invariant", { timeout: 600_000 }, () => {
  for (const row of ROWS) {
    for (const pre of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      const skipped = row.skip?.[pre];
      const title = `${row.name} × ${pre}: ${PRECONDITIONS[pre]}`;
      if (skipped !== undefined) {
        it.skip(`${title} (skipped: ${skipped})`, () => {});
        continue;
      }
      it(title, async () => {
        const { c, o } = await arrange(pre, row);
        const before = await stagedBlobs(c.r);
        const doc = await row.run(c, o);
        expect(doc?.ok, JSON.stringify(doc)).toBe(true);
        if (row.mayNotCommit !== true) expect(doc?.commit, "committed").not.toBeNull();
        if (doc === null) return;
        await assertInvariants(c.r, doc, before, row.newTitle, row.mayNotCommit === true);
        if (pre === 2 && row.name.startsWith("edit (editor")) {
          // ?5 through reachOf: the subject's uncommitted `opened` event joined the commit.
          expect(await git(c.r, "ls-tree", "-r", "--name-only", "HEAD")).toMatch(
            new RegExp(`events/${c.x}/\\S+-opened\\.yaml`),
          );
        }
      });
    }
  }
});

describe("index failures", { timeout: 120_000 }, () => {
  async function base(): Promise<{ r: TempRepo; x: string }> {
    const { c } = await arrange(1, ROWS[0] as Row);
    return { r: c.r, x: c.x };
  }
  const failing =
    (when: number): WriteDeps["apply"] =>
    (log, plan, o) => {
      let n = 0;
      const index = o.index;
      return applyPlan(log, plan, {
        ...o,
        ...(index === undefined
          ? {}
          : {
              index: async (tree, history) => {
                n += 1;
                if (n === when) throw new Error("render failed");
                return index(tree, history);
              },
            }),
      });
    };
  const deps = (apply: WriteDeps["apply"]): WriteDeps => ({ now: Date.now, apply });

  it("leaves nothing behind when the first render fails", async () => {
    const { r, x } = await base();
    const status = await git(r, "status", "--porcelain");
    const log = await open(r);
    await expect(
      commentIssue(
        log,
        { id: x, text: "A comment.", actor: me },
        { commit: true },
        deps(failing(1)),
      ),
    ).rejects.toThrow("render failed");
    expect(await git(r, "status", "--porcelain")).toBe(status);
  });

  it("commits and notes a stale work-tree copy when the render after the commit fails", async () => {
    const { r, x } = await base();
    const doc = await commentIssue(
      await open(r),
      { id: x, text: "A comment.", actor: me },
      { commit: true },
      deps(failing(2)),
    );
    expect(doc.commit).not.toBeNull();
    expect(doc.notes).toContain(`${INDEX} may be stale: render failed; run issues index`);
  });

  it("throws CommitFailedError with the index step when the editor-step render fails", async () => {
    const r = await createTempRepo({ files: { [`${ROOT}/issues.toml`]: CONFIG } });
    repos.push(r);
    await initIssueLog(await open(r), { commit: true });
    await expect(
      openIssue(
        await open(r),
        { title: "Drafted", sections: SECTIONS, actor: me },
        { commit: true, edit: keep },
        deps(failing(2)),
      ),
    ).rejects.toMatchObject({ name: "CommitFailedError" });
    expect(await git(r, "diff", "--cached", "--name-only")).toContain(INDEX);
  });

  it("restores the old index bytes and removes a new index when a write fails after placing it", async () => {
    const { r, x } = await base();
    const old = await readFile(join(r.root, INDEX), "utf8");
    const apply: WriteDeps["apply"] = (log, plan, o) =>
      applyPlan(
        log,
        { ...plan, events: [...plan.events, { ...(plan.events[0] as EventEnvelope), id: "bad" }] },
        o,
      );
    await expect(
      commentIssue(
        await open(r),
        { id: x, text: "A comment.", actor: me },
        { commit: true },
        deps(apply),
      ),
    ).rejects.toThrow();
    expect(await readFile(join(r.root, INDEX), "utf8")).toBe(old);
    await git(r, "rm", "-qf", "--", INDEX);
    await git(r, "commit", "-qm", "chore: drop the index", "--", INDEX);
    await expect(
      commentIssue(
        await open(r),
        { id: x, text: "Again.", actor: me },
        { commit: true },
        deps(apply),
      ),
    ).rejects.toThrow();
    await expect(readFile(join(r.root, INDEX))).rejects.toThrow();
  });
});

describe("index property", { timeout: 600_000 }, () => {
  it("keeps the invariant over random write sequences", async () => {
    type Step = { readonly op: number; readonly who: number; readonly commit: boolean };
    const step = fc.record({
      op: fc.integer({ min: 0, max: 5 }),
      who: fc.integer({ min: 0, max: 2 }),
      commit: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 3, maxLength: 6 }), async (steps: Step[]) => {
        const r = await createTempRepo({
          files: { "README.md": "readme\n", [`${ROOT}/issues.toml`]: CONFIG },
        });
        repos.push(r);
        await initIssueLog(await open(r), { commit: true });
        const ids = [
          await newIssue(r, "First", true),
          await newIssue(r, "Second", true),
          await newIssue(r, "Third", false),
        ];
        for (const s of steps) {
          const log: IssueLog = await open(r);
          const id = ids[s.who] as string;
          const o = { commit: s.commit };
          const before = await stagedBlobs(r);
          let doc: IssueWriteJson | AppliedPlan | null = null;
          switch (s.op) {
            case 0:
              doc = await commentIssue(log, { id, text: "Note.", actor: me }, o);
              break;
            case 1:
              doc = await labelIssue(log, { id, op: { add: ["type:bug"] }, actor: me }, o);
              break;
            case 2:
              doc = await editIssue(log, { id, title: `Title ${s.who} ${s.op}` }, o);
              break;
            case 3:
              doc = await linkIssue(log, { id, to: ids[(s.who + 1) % 3] as string, actor: me }, o);
              break;
            case 4:
              doc = await openIssue(log, { title: "Another", sections: SECTIONS, actor: me }, o);
              break;
            default:
              doc = await assignIssue(log, { id, op: { add: ["ada@example.com"] }, actor: me }, o);
          }
          if (doc !== null && "ok" in doc && doc.ok && doc.commit !== null) {
            await assertInvariants(r, doc, before);
          }
        }
        await rm(r.root, { recursive: true, force: true });
      }),
      { numRuns: 20 },
    );
  });
});
