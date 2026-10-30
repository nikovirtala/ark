import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { RefNotFoundError } from "../errors.js";
import { Git } from "../git/git.js";
import { firstParentAdditions } from "../git/history.js";
import { withGitOperation } from "../git/operation.js";
import { indexReader, refReader, type TreeReader, worktreeReader } from "../git/tree.js";
import { eventPath } from "../identity/layout.js";
import { createUlidFactory } from "../identity/ulid.js";
import { defineKind } from "../kind/define.js";
import { arbSubjectId } from "../testing/arbitraries.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { TEST_HUMAN } from "../testing/history.js";
import { createSpawnLog } from "../testing/spawn-log.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  assignNumbers,
  compareNumberingKeys,
  NO_INDEX_NUMBERING,
  NO_NUMBERING,
  numberLog,
  PENDING_COMMIT,
  projectNumbering,
  resolveMainRef,
} from "./numbering.js";

const run = promisify(execFile);
const layout = kind.layoutAt("log");
const on = "published";
const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";

const path = (subject: string, stamp: string, rand: string, type = on) =>
  `log/events/${subject}/${stamp}-${rand}-${type}.yaml`;

describe("NO_INDEX_NUMBERING", () => {
  it("is frozen, unavailable, with reason no-index and no numbers", () => {
    expect(Object.isFrozen(NO_INDEX_NUMBERING)).toBe(true);
    expect(NO_INDEX_NUMBERING).toMatchObject({ available: false, reason: "no-index", ref: null });
    expect(NO_INDEX_NUMBERING.byId.size).toBe(0);
    expect(NO_INDEX_NUMBERING.byNumber.size).toBe(0);
  });
});

describe("assignNumbers", () => {
  const number = (additions: { path: string; commit: string }[]) =>
    Object.fromEntries(assignNumbers(additions, { layout, on }));

  it("numbers subjects in commit order, once each", () => {
    expect(
      number([
        { path: path(B, "20260101T000000Z", "0000"), commit: "c1" },
        { path: path(A, "20250101T000000Z", "0000"), commit: "c2" },
        { path: path(B, "20270101T000000Z", "0000"), commit: "c3" },
        { path: path(C, "20260101T000000Z", "0000"), commit: "c3" },
      ]),
    ).toEqual({ [B]: 1, [A]: 2, [C]: 3 });
  });

  it("orders one commit's files by stamp, not by subject id", () => {
    // git lists A's path first; B's acceptance is older.
    expect(
      number([
        { path: path(A, "20260102T000000Z", "0000"), commit: "c1" },
        { path: path(B, "20260101T000000Z", "zzzz"), commit: "c1" },
      ]),
    ).toEqual({ [B]: 1, [A]: 2 });
  });

  it("orders the same stamp by rand, then by subject", () => {
    expect(
      number([
        { path: path(A, "20260101T000000Z", "k000"), commit: "c1" },
        { path: path(C, "20260101T000000Z", "0001"), commit: "c1" },
        { path: path(B, "20260101T000000Z", "0001"), commit: "c1" },
      ]),
    ).toEqual({ [B]: 1, [C]: 2, [A]: 3 });
  });

  it("ignores other types, invalid directories and unparsable names", () => {
    expect(
      number([
        { path: path(A, "20260101T000000Z", "0000", "created"), commit: "c1" },
        { path: path("not-an-id", "20260101T000000Z", "0000"), commit: "c1" },
        { path: `log/events/${A}/nested/20260101T000000Z-0000-published.yaml`, commit: "c1" },
        { path: "log/events/20260101T000000Z-0000-published.yaml", commit: "c1" },
        { path: `log/events/${A}/published.yaml`, commit: "c1" },
        { path: `other/events/${A}/20260101T000000Z-0000-published.yaml`, commit: "c1" },
        { path: `log/items/${A}.md`, commit: "c1" },
        { path: path(B, "20260101T000000Z", "0000"), commit: "c2" },
      ]),
    ).toEqual({ [B]: 1 });
  });

  it("never changes existing numbers when additions are appended", () => {
    const arbAddition = fc
      .record({
        subject: arbSubjectId(),
        stamp: fc.constantFrom("20260101T000000Z", "20260102T000000Z"),
        rand: fc.constantFrom("0000", "0001", "zzzz"),
        type: fc.constantFrom(on, "created", "noted"),
        commit: fc.constantFrom("c1", "c2", "c3", "c4"),
      })
      .map((a) => ({ path: path(a.subject, a.stamp, a.rand, a.type), commit: a.commit }));
    fc.assert(
      fc.property(fc.array(arbAddition), fc.array(arbAddition), fc.string(), (old, added, tag) => {
        // Appended commits are new commits, so they never join a commit already listed.
        const later = added.map((a) => ({ ...a, commit: `${tag}/${a.commit}` }));
        const before = assignNumbers(old, { layout, on });
        const after = assignNumbers([...old, ...later], { layout, on });
        for (const [id, n] of before) expect(after.get(id)).toBe(n);
        expect(new Set(after.values()).size).toBe(after.size);
        expect([...after.values()].sort((x, y) => x - y)).toEqual(
          Array.from({ length: after.size }, (_, i) => i + 1),
        );
      }),
    );
  });
});

describe("compareNumberingKeys", () => {
  const key = (stamp: string, rand: string, subject: string) => ({ stamp, rand, subject });

  it("orders by stamp, then rand, then subject", () => {
    const keys = [
      key("20260102T000000Z", "0000", A),
      key("20260101T000000Z", "zzzz", A),
      key("20260101T000000Z", "0001", C),
      key("20260101T000000Z", "0001", B),
    ];
    expect([...keys].sort(compareNumberingKeys)).toEqual([keys[3], keys[2], keys[1], keys[0]]);
    expect(compareNumberingKeys(keys[0] as never, keys[0] as never)).toBe(0);
  });
});

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "repo\n" } });
  repos.push(r);
  return r;
}

let seq = 0;
/** Writes and commits a `published` event for `subject` at `at`. */
async function publish(r: TempRepo, subject: string, at: string): Promise<string> {
  await r.stage(await writePublished(r, subject, at));
  return r.commit(`publish ${subject}`);
}

/**
 * Writes a `published` event for `subject` at `at` to the work tree of a temp repo or of the
 * repository at a path; returns its path.
 */
async function writePublished(r: TempRepo | string, subject: string, at: string): Promise<string> {
  seq += 1;
  const e: EventEnvelope = {
    envelope: "ledger/v1",
    kind: "widget",
    schema: "widget/v1",
    id: createUlidFactory({ now: () => Date.parse(at), random: (b) => b.fill(seq) })(),
    subject,
    type: on,
    at,
    actor: TEST_HUMAN,
    data: { body_sha256: "0".repeat(64) },
  };
  const p = eventPath(layout, e);
  if (typeof r !== "string") await r.write(p, serializeEvent(e));
  else {
    await mkdir(dirname(join(r, p)), { recursive: true });
    await writeFile(join(r, p), serializeEvent(e));
  }
  return p;
}

/** A `git clone --depth 1` of `r`, opened. */
async function shallowClone(r: TempRepo): Promise<Git> {
  const dest = join(r.root, "..", `shallow-${++seq}`);
  const env = { ...process.env, ...r.git.options.env } as Record<string, string>;
  await run("git", ["clone", "-q", "--depth", "1", `file://${r.root}`, dest], { env });
  return Git.open(dest, r.git.options);
}

const numbersOf = async (git: Git, mainRef?: string | null) =>
  Object.fromEntries(
    (await numberLog(git, { kind, layout, ...(mainRef === undefined ? {} : { mainRef }) })).byId,
  );

describe("numberLog", () => {
  it("numbers acceptances in first-parent order", async () => {
    const r = await repo();
    await publish(r, B, "2026-01-02T00:00:00Z");
    const head = await publish(r, A, "2026-01-01T00:00:00Z");
    const n = await numberLog(r.git, { kind, layout });
    expect(n).toMatchObject({
      available: true,
      reason: null,
      ref: "refs/heads/main",
      commit: head,
    });
    expect(Object.fromEntries(n.byId)).toEqual({ [B]: 1, [A]: 2 });
    expect(Object.fromEntries(n.byNumber)).toEqual({ 1: B, 2: A });
  });

  it("numbers a --no-ff merge's acceptances at the merge commit", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    await publish(r, B, "2026-01-02T00:00:00Z");
    await r.checkout("main");
    await publish(r, C, "2026-01-03T00:00:00Z");
    await r.merge("feature", { noFf: true });
    expect(await numbersOf(r.git)).toEqual({ [A]: 1, [C]: 2, [B]: 3 });
  });

  it("numbers a rebase-merged branch in its rebased order", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    await publish(r, B, "2026-01-02T00:00:00Z");
    await r.checkout("main");
    await publish(r, C, "2026-01-03T00:00:00Z");
    await r.checkout("feature");
    await r.git.run(["rebase", "-q", "main"]);
    await r.checkout("main");
    await r.git.run(["merge", "-q", "--ff-only", "feature"]);
    expect(await numbersOf(r.git)).toEqual({ [A]: 1, [C]: 2, [B]: 3 });
  });

  it("leaves an acceptance that is only on a branch unnumbered", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    await publish(r, B, "2026-01-02T00:00:00Z");
    expect(await numbersOf(r.git)).toEqual({ [A]: 1 });
  });

  it("is unavailable in a shallow clone", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    const dest = join(r.root, "..", "shallow");
    const env = { ...process.env, ...r.git.options.env } as Record<string, string>;
    await run("git", ["clone", "-q", "--depth", "1", `file://${r.root}`, dest], { env });
    const shallow = await Git.open(dest, r.git.options);
    expect(await numberLog(shallow, { kind, layout })).toEqual({
      ...NO_NUMBERING,
      reason: "shallow",
    });
  });

  it("prefers origin/HEAD's target over origin/main and local main", async () => {
    const r = await repo();
    const first = await publish(r, A, "2026-01-01T00:00:00Z");
    const second = await publish(r, B, "2026-01-02T00:00:00Z");
    await publish(r, C, "2026-01-03T00:00:00Z");
    await r.git.run(["update-ref", "refs/remotes/origin/main", first]);
    expect(await resolveMainRef(r.git)).toBe("refs/remotes/origin/main");
    expect(await numbersOf(r.git)).toEqual({ [A]: 1 });
    await r.git.run(["update-ref", "refs/remotes/origin/trunk", second]);
    await r.git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    expect(await resolveMainRef(r.git)).toBe("refs/remotes/origin/trunk");
    expect(await numbersOf(r.git)).toEqual({ [A]: 1, [B]: 2 });
  });

  it("falls back to master and reports no main ref when nothing resolves", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.git.run(["branch", "-m", "main", "master"]);
    expect(await resolveMainRef(r.git)).toBe("refs/heads/master");
    await r.git.run(["branch", "-m", "master", "trunk"]);
    expect(await resolveMainRef(r.git)).toBeNull();
    expect(await numberLog(r.git, { kind, layout })).toBe(NO_NUMBERING);
  });

  it("uses a configured ref as given and refuses a missing one", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("release", { create: true });
    await publish(r, B, "2026-01-02T00:00:00Z");
    expect(await numbersOf(r.git, "release")).toEqual({ [A]: 1, [B]: 2 });
    expect((await numberLog(r.git, { kind, layout, mainRef: "release" })).ref).toBe("release");
    await expect(numberLog(r.git, { kind, layout, mainRef: "nope" })).rejects.toBeInstanceOf(
      RefNotFoundError,
    );
    await expect(resolveMainRef(r.git, "nope")).rejects.toMatchObject({ ref: "nope" });
  });

  it("returns NO_NUMBERING for a kind without numbering", async () => {
    const r = await repo();
    const { numbering: _, ...def } = kind.def;
    const plain = defineKind(def as never);
    expect(await numberLog(r.git, { kind: plain, layout })).toBe(NO_NUMBERING);
  });
});

describe("projectNumbering", () => {
  const project = async (git: Git, history: string | null, tree: TreeReader) =>
    projectNumbering(git, { kind, layout, history, tree });

  it("projects a branch's numbers to what main gives after a fast-forward", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    // Two commits, the later one with the older stamp: commit order decides.
    await publish(r, C, "2026-01-03T00:00:00Z");
    const tip = await publish(r, B, "2026-01-02T00:00:00Z");
    expect(await numbersOf(r.git)).toEqual({ [A]: 1 });
    const projected = await project(r.git, tip, await refReader(r.git, tip));
    expect(projected).toMatchObject({ available: true, reason: null, ref: null, commit: tip });
    expect(Object.fromEntries(projected.byId)).toEqual({ [A]: 1, [C]: 2, [B]: 3 });
    expect(Object.fromEntries(projected.byNumber)).toEqual({ 1: A, 2: C, 3: B });
    await r.checkout("main");
    await r.git.run(["merge", "-q", "--ff-only", "feature"]);
    expect(Object.fromEntries((await numberLog(r.git, { kind, layout })).byId)).toEqual(
      Object.fromEntries(projected.byId),
    );
  });

  it("numbers main's acceptances first on a branch that merged main, as its merge does", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    await publish(r, B, "2026-01-02T00:00:00Z");
    await r.checkout("main");
    await publish(r, C, "2026-01-03T00:00:00Z");
    await r.checkout("feature");
    // GitHub's "Update branch": main merged into the branch.
    const updated = await r.merge("main", { noFf: true });
    const projected = await project(r.git, updated, await refReader(r.git, updated));
    expect(Object.fromEntries(projected.byId)).toEqual({ [A]: 1, [C]: 2, [B]: 3 });
    await r.checkout("main");
    const merged = await r.merge("feature", { noFf: true });
    expect(await numbersOf(r.git)).toEqual(Object.fromEntries(projected.byId));
    const result = await project(r.git, merged, await refReader(r.git, merged));
    expect(Object.fromEntries(result.byId)).toEqual(Object.fromEntries(projected.byId));
  });

  it("numbers a merge of main in progress like its result, given MERGE_HEAD", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    const tip = await publish(r, B, "2026-01-02T00:00:00Z");
    await r.checkout("main");
    const main = await publish(r, C, "2026-01-03T00:00:00Z");
    await r.checkout("feature");
    await r.git.run(["merge", "-q", "--no-ff", "--no-commit", "main"]);
    const staged = await indexReader(r.git);
    const merging = await projectNumbering(r.git, {
      kind,
      layout,
      history: tip,
      tree: staged,
      merging: [main],
    });
    expect(Object.fromEntries(merging.byId)).toEqual({ [A]: 1, [C]: 2, [B]: 3 });
    // Without it, main's acceptance is pending, after the branch's.
    expect(Object.fromEntries((await project(r.git, tip, staged)).byId)).toEqual({
      [A]: 1,
      [B]: 2,
      [C]: 3,
    });
  });

  it("numbers as history's first-parent line alone on main, a rebased branch and without a main ref", async () => {
    const r = await repo();
    const first = await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    await publish(r, B, "2026-01-02T00:00:00Z");
    await r.checkout("main");
    await publish(r, C, "2026-01-03T00:00:00Z");
    await writePublished(r, "dddddddd", "2026-01-04T00:00:00Z");
    /** The projection numbering `history`'s first-parent additions only. */
    const alone = async (history: string, tree: TreeReader) => {
      const additions = await firstParentAdditions(r.git, history, "log/events");
      const pending = (await tree.list("log/events")).map((e) => ({
        path: e.path,
        commit: PENDING_COMMIT,
      }));
      const byId = assignNumbers([...additions, ...pending], { layout, on });
      return { ...(await project(r.git, history, tree)), byId };
    };
    const check = async (history: string, mainRef?: string) => {
      const tree = worktreeReader(r.git);
      const n = await projectNumbering(r.git, {
        kind,
        layout,
        history,
        tree,
        ...(mainRef === undefined ? {} : { mainRef }),
      });
      const expected = await alone(history, tree);
      expect(Object.fromEntries(n.byId)).toEqual(Object.fromEntries(expected.byId));
      expect([...n.byId]).toEqual([...expected.byId]);
      return n;
    };
    const head = (await r.git.resolveCommit("HEAD")) as string;
    // On main, also ahead of and behind origin/main.
    expect(Object.fromEntries((await check(head)).byId)).toEqual({
      [A]: 1,
      [C]: 2,
      dddddddd: 3,
    });
    await r.git.run(["update-ref", "refs/remotes/origin/main", first]);
    await check(head);
    await r.git.run(["update-ref", "refs/remotes/origin/main", head]);
    await check(first);
    await r.git.run(["update-ref", "-d", "refs/remotes/origin/main"]);
    // A branch rebased onto main.
    await r.checkout("feature");
    await r.git.run(["rebase", "-q", "main"]);
    const rebased = (await r.git.resolveCommit("HEAD")) as string;
    expect(Object.fromEntries((await check(rebased)).byId)).toEqual({
      [A]: 1,
      [C]: 2,
      [B]: 3,
      dddddddd: 4,
    });
    // A branch that merged main, without a main ref and with a configured ref that is missing.
    await r.git.run(["reset", "-q", "--hard", first]);
    await publish(r, B, "2026-01-02T00:00:00Z");
    const updated = await r.merge("main", { noFf: true });
    await r.git.run(["branch", "-m", "main", "trunk"]);
    expect(Object.fromEntries((await check(updated)).byId)).toEqual({
      [A]: 1,
      [B]: 2,
      [C]: 3,
      dddddddd: 4,
    });
    await check(updated, "nope");
  });

  it("numbers the tree's pending acceptances after history, sorted like one commit", async () => {
    const r = await repo();
    const head = await publish(r, A, "2026-01-02T00:00:00Z");
    await writePublished(r, C, "2026-01-01T00:00:00Z");
    await r.stage(await writePublished(r, B, "2026-01-03T00:00:00Z"));
    // A second acceptance of a numbered subject doesn't renumber it.
    await writePublished(r, A, "2026-01-04T00:00:00Z");
    const work = await project(r.git, head, worktreeReader(r.git));
    expect(work.commit).toBe(head);
    expect(Object.fromEntries(work.byId)).toEqual({ [A]: 1, [C]: 2, [B]: 3 });
    const staged = await project(r.git, head, await indexReader(r.git));
    expect(Object.fromEntries(staged.byId)).toEqual({ [A]: 1, [B]: 2 });
  });

  it("numbers only the pending acceptances on an unborn HEAD", async () => {
    const r = await createTempRepo();
    repos.push(r);
    await writePublished(r, B, "2026-01-01T00:00:00Z");
    await writePublished(r, A, "2026-01-02T00:00:00Z");
    const n = await project(r.git, null, worktreeReader(r.git));
    expect(n).toMatchObject({ available: true, reason: null, ref: null, commit: null });
    expect(Object.fromEntries(n.byId)).toEqual({ [B]: 1, [A]: 2 });
  });

  it("is unavailable without numbering and in a shallow clone", async () => {
    const r = await repo();
    const head = await publish(r, A, "2026-01-01T00:00:00Z");
    const { numbering: _, ...def } = kind.def;
    const plain = defineKind(def as never);
    expect(
      await projectNumbering(r.git, {
        kind: plain,
        layout,
        history: head,
        tree: worktreeReader(r.git),
      }),
    ).toBe(NO_NUMBERING);
    const dest = join(r.root, "..", "shallow");
    const env = { ...process.env, ...r.git.options.env } as Record<string, string>;
    await run("git", ["clone", "-q", "--depth", "1", `file://${r.root}`, dest], { env });
    const shallow = await Git.open(dest, r.git.options);
    expect(await project(shallow, head, worktreeReader(shallow))).toEqual({
      ...NO_NUMBERING,
      reason: "shallow",
    });
  });

  it("continues a shallow clone's recorded numbers with the pending acceptances", async () => {
    const r = await repo();
    const head = await publish(r, A, "2026-01-01T00:00:00Z");
    const shallow = await shallowClone(r);
    const root = shallow.root as string;
    const D = "dddddddd";
    const E = "eeeeeeee";
    await writePublished(root, E, "2026-01-03T00:00:00Z");
    await writePublished(root, D, "2026-01-04T00:00:00Z");
    // A recorded subject's later acceptance keeps its number.
    await writePublished(root, B, "2026-01-02T00:00:00Z");
    const recorded = new Map([
      [A, 1],
      [B, 2],
      [C, 5],
    ]);
    const n = await projectNumbering(shallow, {
      kind,
      layout,
      history: head,
      tree: worktreeReader(shallow),
      recorded: async () => recorded,
    });
    expect(n).toMatchObject({ available: true, reason: "index", ref: null, commit: head });
    expect(Object.fromEntries(n.byId)).toEqual({ [A]: 1, [B]: 2, [C]: 5, [E]: 6, [D]: 7 });
    expect(Object.fromEntries(n.byNumber)).toEqual({ 1: A, 2: B, 5: C, 6: E, 7: D });
    expect(recorded.size).toBe(3);
    const none = await projectNumbering(shallow, {
      kind,
      layout,
      history: head,
      tree: worktreeReader(shallow),
      recorded: async () => null,
    });
    expect(none).toEqual({ ...NO_NUMBERING, reason: "shallow" });
  });

  it("numbers pending acceptances the same way with recorded numbers as with history", async () => {
    const r = await repo();
    await publish(r, B, "2026-01-02T00:00:00Z");
    const head = await publish(r, A, "2026-01-01T00:00:00Z");
    const shallow = await shallowClone(r);
    const pending: [string, string][] = [
      ["dddddddd", "2026-01-05T00:00:00Z"],
      [C, "2026-01-03T00:00:00Z"],
      ["eeeeeeee", "2026-01-03T00:00:00Z"],
    ];
    for (const [subject, at] of pending) {
      // The same file in both work trees.
      const p = await writePublished(r, subject, at);
      await mkdir(dirname(join(shallow.root as string, p)), { recursive: true });
      await writeFile(join(shallow.root as string, p), await readFile(join(r.root, p)));
    }
    const full = await project(r.git, head, worktreeReader(r.git));
    const fromHistory = (await numberLog(r.git, { kind, layout })).byId;
    const fromIndex = await projectNumbering(shallow, {
      kind,
      layout,
      history: head,
      tree: worktreeReader(shallow),
      recorded: async () => fromHistory,
    });
    expect(fromIndex.reason).toBe("index");
    expect(Object.fromEntries(fromIndex.byId)).toEqual(Object.fromEntries(full.byId));
    expect(full.byId.size).toBe(5);
  });
});

describe("numberLog in a shallow clone", () => {
  it("uses the fallback's numbers, and is unavailable when it has none", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    const shallow = await shallowClone(r);
    const recorded = new Map([
      [A, 1],
      [B, 3],
    ]);
    const n = await numberLog(shallow, { kind, layout, fallback: async () => recorded });
    expect(n).toMatchObject({ available: true, reason: "index", ref: null, commit: null });
    expect(Object.fromEntries(n.byId)).toEqual({ [A]: 1, [B]: 3 });
    expect(Object.fromEntries(n.byNumber)).toEqual({ 1: A, 3: B });
    expect(await numberLog(shallow, { kind, layout, fallback: async () => null })).toEqual({
      ...NO_NUMBERING,
      reason: "shallow",
    });
  });

  it("ignores the fallback in a full clone", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    let called = false;
    const fallback = async () => {
      called = true;
      return new Map([[B, 1]]);
    };
    const n = await numberLog(r.git, { kind, layout, fallback });
    expect(n.reason).toBeNull();
    expect(Object.fromEntries(n.byId)).toEqual({ [A]: 1 });
    expect(called).toBe(false);
  });
});

describe("history reads in a git operation", () => {
  it("lists history and trees once per generation, and again after a commit", async () => {
    const r = await repo();
    await publish(r, A, "2026-01-01T00:00:00Z");
    await r.checkout("feature", { create: true });
    await publish(r, B, "2026-01-02T00:00:00Z");
    await r.checkout("main");
    await publish(r, C, "2026-01-03T00:00:00Z");
    await r.checkout("feature");
    const updated = await r.merge("main", { noFf: true });
    const log = await createSpawnLog();
    try {
      const git = await Git.open(r.root, { ...r.git.options, binary: log.binary });
      const both = async () => [
        Object.fromEntries((await numberLog(git, { kind, layout })).byId),
        Object.fromEntries(
          (
            await projectNumbering(git, {
              kind,
              layout,
              history: updated,
              tree: await refReader(git, updated),
            })
          ).byId,
        ),
      ];
      const counts = async () => ({
        log: await log.count(" log "),
        revList: await log.count(" rev-list "),
        lsTree: await log.count(" ls-tree "),
      });
      const outside = await both();
      const once = await counts();
      await withGitOperation(async () => {
        expect(await both()).toEqual(outside);
        const first = await counts();
        // numberLog and the projection share main's additions: 2 logs where 3 ran outside.
        expect(first).toEqual({ log: once.log + 2, revList: 2, lsTree: 2 });
        expect(once).toEqual({ log: 3, revList: 1, lsTree: 1 });
        expect(await both()).toEqual(outside);
        expect(await counts()).toEqual(first);
        // Each caller gets its own array.
        const a = await firstParentAdditions(git, updated, "log/events");
        a.pop();
        expect(await firstParentAdditions(git, updated, "log/events")).toHaveLength(a.length + 1);
        const t = await refReader(git, updated);
        (await t.list("log")).pop();
        expect(await t.list("log")).toEqual(await (await refReader(r.git, updated)).list("log"));
        await git.run(["commit", "-q", "--allow-empty", "-m", "empty"]);
        await both();
        const after = await counts();
        expect(after.log).toBeGreaterThan(first.log);
        expect(after.revList).toBeGreaterThan(first.revList);
      });
    } finally {
      await log.dispose();
    }
  });
});
