import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { type Finding, finding } from "../findings/finding.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  type FollowRenames,
  type PreCommitHookOptions,
  readCommitMessage,
  runPreCommitHook,
  stagedEventTrailers,
} from "./hook-steps.js";
import { openToolLog, type ToolLog } from "./tool-log.js";

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const KEYS = { subject: "Widget", event: "Widget-Event" };
const ev = (subject: string, file: string) => `log/events/${subject}/${file}`;

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = { "README.md": "x\n" }): Promise<TempRepo> {
  const r = await createTempRepo({ files });
  repos.push(r);
  return r;
}
const open = (r: TempRepo, reader: "worktree" | "index" = "worktree") =>
  openToolLog({ cwd: r.root, tool: "widget", kind, reader, gitOptions: { env: r.env } });

describe("readCommitMessage", () => {
  it("refuses a missing message file", async () => {
    const r = await repo();
    await expect(readCommitMessage(r.git, "nope", KEYS)).rejects.toThrow(
      new UsageError("no commit message file at nope"),
    );
  });

  it("returns the absolute file and its parsed trailers", async () => {
    const r = await repo();
    await r.write("MSG", "feat: x\n\nbody\n\nOther: 1\nWidget: aaaaaaaa\n");
    expect(await readCommitMessage(r.git, "MSG", KEYS)).toEqual({
      file: join(r.root, "MSG"),
      parsed: "Other: 1\nWidget: aaaaaaaa\n",
    });
  });

  it.each(["Widget-Event: created", "widget-event : created", "WIDGET-EVENT:created"])(
    "is null when the message has the trailer %j",
    async (trailer) => {
      const r = await repo();
      await r.write("MSG", `feat: x\n\n${trailer}\n`);
      expect(await readCommitMessage(r.git, "MSG", KEYS)).toBeNull();
    },
  );

  it("matches the event key literally, and only as a trailer key", async () => {
    const r = await repo();
    await r.write("MSG", "feat: x\n\nWxE: created\n");
    expect(await readCommitMessage(r.git, "MSG", { event: "W.E" })).not.toBeNull();
    await r.write("MSG", "feat: x\n\nWidget-Event-Other: created\n");
    expect(await readCommitMessage(r.git, "MSG", KEYS)).not.toBeNull();
  });

  it("is null during a merge", async () => {
    const r = await repo();
    await r.write("MSG", "Merge branch x\n");
    const head = await r.git.resolveCommit("HEAD");
    await writeFile(join(r.git.gitDir, "MERGE_HEAD"), `${head}\n`);
    expect(await readCommitMessage(r.git, "MSG", KEYS)).toBeNull();
  });
});

describe("stagedEventTrailers", () => {
  it("gives the staged added event files' refs and trailers, in path order", async () => {
    const r = await repo({ [ev(A, "20260101T000000Z-0000-published.yaml")]: "x\n" });
    await r.writeFiles({
      [ev(A, "20260101T000000Z-0000-published.yaml")]: "changed\n",
      [ev(B, "20260102T000000Z-0001-created.yaml")]: "x\n",
      [ev(A, "20260103T000000Z-0002-created.yaml")]: "x\n",
      [ev(A, "20260104T000000Z-0003-created.yaml")]: "x\n",
      [ev(A, "notes.md")]: "x\n",
      [ev(A, "sub/20260105T000000Z-0004-retired.yaml")]: "x\n",
      "src/20260106T000000Z-0005-retired.yaml": "x\n",
    });
    await r.stage(".");
    const layout = kind.layoutAt("log");
    expect(await stagedEventTrailers(r.git, layout, KEYS)).toEqual({
      refs: [
        { subject: A, type: "created" },
        { subject: B, type: "created" },
      ],
      trailers: [
        ["Widget", A],
        ["Widget-Event", "created"],
        ["Widget", B],
        ["Widget-Event", "created"],
      ],
    });
  });
});

/** A pre-commit run with stub steps; `calls` records each followRenames call. */
async function preCommit(
  r: TempRepo,
  o: Partial<PreCommitHookOptions<ToolLog>> & {
    readonly follow?: Partial<Awaited<ReturnType<FollowRenames<ToolLog>>>>;
    readonly findings?: readonly Finding[];
    readonly worktreeNotes?: readonly string[];
  } = {},
) {
  const calls: unknown[] = [];
  const worktree = { ...(await open(r)), notes: o.worktreeNotes ?? [] };
  const index = { ...(await open(r, "index")), notes: ["index note"] };
  const result = await runPreCommitHook({
    tool: "widget",
    worktree,
    index,
    env: { ...r.env, ARK_AGENT: "bot" },
    config: { failOn: "error", scopeFollowRenames: "stage", hookIndex: "check", index: "none" },
    async followRenames(log, input, mode) {
      calls.push([log === worktree, input.actor.kind, mode]);
      return { ok: true, findings: [], notes: [], affected: [], ...o.follow };
    },
    renderIndex: async () => "the index\n",
    verify: async () => o.findings ?? [],
    ...o,
  });
  return { result, calls };
}

/** A repo with one staged rename. */
async function renamed(): Promise<TempRepo> {
  const r = await repo({ "src/a.ts": "a\n" });
  await r.git.run(["mv", "src/a.ts", "src/b.ts"]);
  return r;
}

const warning = finding({
  severity: "warning",
  rule: "x/y",
  message: "w",
  file: null,
  subject: null,
});
const W = { display: "W-1" };
const W2 = { display: "W-2" };
const ATTRIBUTION = /^on_behalf_of taken from the git identity/;

describe("runPreCommitHook", () => {
  it("exits by verify's findings and failOn, with the index log's notes", async () => {
    const r = await repo();
    const ok = await preCommit(r, { findings: [warning] });
    expect(ok.result).toEqual({
      exit: 0,
      findings: [warning],
      notes: ["index note"],
      failOn: "error",
    });
    const strict = await preCommit(r, {
      findings: [warning],
      config: { failOn: "warning", scopeFollowRenames: "stage", hookIndex: "check", index: "none" },
    });
    expect(strict.result.exit).toBe(1);
  });

  it("follows staged renames on the work-tree log, with the attribution notes", async () => {
    const r = await renamed();
    const { result, calls } = await preCommit(r, {
      follow: { notes: ["index note", "scoped W-1"] },
    });
    expect(calls).toEqual([
      [true, "agent", { index: "skip", notes: [expect.stringMatching(ATTRIBUTION)] }],
    ]);
    expect(result.notes).toEqual(["index note", "scoped W-1"]);
  });

  it("stops when the rename following fails", async () => {
    const r = await renamed();
    const { result } = await preCommit(r, {
      follow: { ok: false, findings: [warning] },
      findings: [],
    });
    expect(result).toMatchObject({ exit: 1, findings: [warning] });
  });

  it("drops the work-tree log's notes from the rename following's only with dropWorktreeNotes", async () => {
    const r = await renamed();
    const follow = { notes: ["work-tree note", "scoped W-1"] };
    const worktreeNotes = ["work-tree note"];
    const kept = await preCommit(r, { follow, worktreeNotes });
    expect(kept.result.notes).toEqual(["index note", "work-tree note", "scoped W-1"]);
    const dropped = await preCommit(r, { follow, worktreeNotes, dropWorktreeNotes: true });
    expect(dropped.result.notes).toEqual(["index note", "scoped W-1"]);
  });

  it("only warns with scope_follow_renames = warn, and does nothing with off", async () => {
    const r = await renamed();
    const warn = await preCommit(r, {
      follow: { affected: [W, W2] },
      config: { failOn: "error", scopeFollowRenames: "warn", hookIndex: "check", index: "none" },
    });
    expect(warn.calls).toEqual([[true, "agent", { dryRun: true }]]);
    expect(warn.result.exit).toBe(0);
    expect(warn.result.notes.slice(1)).toEqual([
      `W-1's globs don't follow the renames in this commit (scope_follow_renames = "warn"); run widget scope --follow-renames`,
      `W-2's globs don't follow the renames in this commit (scope_follow_renames = "warn"); run widget scope --follow-renames`,
    ]);
    const off = await preCommit(r, {
      config: { failOn: "error", scopeFollowRenames: "off", hookIndex: "check", index: "none" },
    });
    expect(off.calls).toEqual([]);
  });

  it("refuses renames that change a scope on a temporary index", async () => {
    const r = await renamed();
    const env = { ...r.env, ARK_AGENT: "bot", GIT_INDEX_FILE: join(r.git.gitDir, "other-index") };
    const refused = await preCommit(r, { env, follow: { affected: [W, W2] }, findings: [warning] });
    expect(refused.calls).toEqual([[true, "agent", { dryRun: true }]]);
    expect(refused.result).toMatchObject({ exit: 1, findings: [] });
    expect(refused.result.notes.at(-1)).toBe(
      `the renames in this commit change the scope of W-1, W-2; git commit <paths> can't take the scoped events. Run widget scope --follow-renames, then commit again including the files it lists, or set [hooks] scope_follow_renames = "warn"`,
    );
    const passes = await preCommit(r, { env, findings: [warning] });
    expect(passes.result).toMatchObject({ exit: 0, findings: [warning] });
    // The real index, named explicitly, is safe.
    const real = { ...env, GIT_INDEX_FILE: join(r.git.gitDir, "index") };
    expect((await preCommit(r, { env: real })).calls[0]).toMatchObject([
      true,
      "agent",
      { index: "skip" },
    ]);
  });

  it("regenerates and stages index.md only in stage mode and on the real index", async () => {
    const stage = {
      failOn: "error",
      scopeFollowRenames: "off",
      hookIndex: "stage",
      index: "committed",
    } as const;
    const r = await repo();
    const check = await preCommit(r, { config: { ...stage, hookIndex: "check" } });
    expect(check.result.notes).toEqual(["index note"]);
    const unsafe = await preCommit(r, { config: stage, env: { GIT_INDEX_FILE: "/elsewhere" } });
    expect(unsafe.result.notes).toEqual(["index note"]);
    const staged = await preCommit(r, { config: stage });
    expect(staged.result.notes).toEqual(["index note", "regenerated and staged log/index.md"]);
    expect(await readFile(join(r.root, "log/index.md"), "utf8")).toBe("the index\n");
    expect(await r.git.stagedPaths(["log"])).toEqual(["log/index.md"]);
    const again = await preCommit(r, { config: stage });
    expect(again.result.notes).toEqual(["index note"]);
  });
});
