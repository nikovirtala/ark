import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpawnLog, realGit, type SpawnLog } from "../testing/spawn-log.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { catFileBatch, Git, spawnSpec } from "./git.js";
import { liveResidentCount, withGitOperation } from "./operation.js";
import { CatFileProcess, ResidentGone } from "./resident.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  expect(liveResidentCount()).toBe(0);
});

async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  cleanup.push(() => r.dispose());
  return r;
}

async function spawnLog(): Promise<SpawnLog> {
  const log = await createSpawnLog();
  cleanup.push(() => log.dispose());
  return log;
}

const BATCH = "cat-file --batch";
const VERIFY = "rev-parse --verify";

/** Each rev's `resolveCommit` answer outside an operation, then inside one. */
async function answers(
  git: Git,
  revs: readonly string[],
  log: SpawnLog,
): Promise<{ outside: (string | null)[]; inside: (string | null)[]; batches: number }> {
  const outside: (string | null)[] = [];
  for (const rev of revs) outside.push(await git.resolveCommit(rev));
  const before = await log.count(BATCH);
  const inside = await withGitOperation(async () => {
    const out: (string | null)[] = [];
    for (const rev of revs) out.push(await git.resolveCommit(rev));
    expect(liveResidentCount()).toBe(1);
    return out;
  });
  expect(liveResidentCount()).toBe(0);
  return { outside, inside, batches: (await log.count(BATCH)) - before };
}

describe("the resident cat-file", () => {
  it("answers every lookup of one operation, where each spawned a process before", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const log = await spawnLog();
    const git = await Git.open(r.root, { binary: log.binary, env: r.env });
    const head = await r.git.resolveCommit("HEAD");
    const blob = (await r.git.run(["rev-parse", "HEAD:a.txt"])).stdout;
    const oid = Buffer.from(blob).toString("utf8").trim();
    const lookups = async () => {
      for (let i = 0; i < 20; i++) expect(await git.resolveCommit("HEAD")).toBe(head);
      for (let i = 0; i < 3; i++) {
        const [obj] = await catFileBatch(git, [oid]);
        expect(obj?.type).toBe("blob");
        expect(Buffer.from(obj?.bytes ?? []).toString("utf8")).toBe("a\n");
        expect((await git.readBlobs([oid])).get(oid)).toEqual(obj?.bytes);
      }
    };
    await lookups();
    expect(await log.count(VERIFY)).toBe(20);
    expect(await log.count(BATCH)).toBe(6);
    await withGitOperation(lookups);
    expect(await log.count(VERIFY)).toBe(20);
    expect(await log.count(BATCH)).toBe(7);
  });

  it("resolves every rev as rev-parse does, and sends the forms it can't answer one-shot", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    await r.write("b.txt", "b\n");
    await r.stage("b.txt");
    await r.commit("second");
    await r.git.run(["tag", "-a", "-m", "annotated", "v1", "HEAD~1"]);
    await r.git.run(["tag", "lt"]);
    await r.git.run(["tag", "dup", "HEAD~1"]);
    await r.git.run(["branch", "dup"]);
    await r.git.run(["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
    await r.checkout("other", { create: true });
    await r.checkout("main");
    const head = (await r.git.resolveCommit("HEAD")) as string;
    const rp = async (rev: string) =>
      Buffer.from((await r.git.run(["rev-parse", rev])).stdout)
        .toString("utf8")
        .trim();
    const log = await spawnLog();
    const git = await Git.open(r.root, { binary: log.binary, env: r.env });
    const resident = [
      "HEAD",
      "HEAD~1",
      "HEAD~999",
      "main",
      "refs/heads/main",
      head,
      head.slice(0, 7),
      "v1",
      "lt",
      "dup",
      await rp("HEAD^{tree}"),
      await rp("HEAD:a.txt"),
      "nope",
      "refs/heads/nope",
      "MERGE_HEAD",
      "@",
      "origin/main",
      "HEAD^{/second}",
      "HEAD^{/[}",
      "HEAD^{bogus}",
      "HEAD^0",
      "HEAD^!",
      "HEAD...HEAD",
      "..HEAD",
      "a b",
    ];
    const oneShot = ["^HEAD", "@{-1}", "@{upstream}", "nobranch@{u}", "HEAD@{100}"];
    oneShot.push("HEAD:../a", "HEAD:a.txt", ":a.txt", "HEAD\nx");
    const { outside, inside, batches } = await answers(git, [...resident, ...oneShot], log);
    expect(inside).toEqual(outside);
    expect(batches).toBe(1);
    expect(outside.slice(0, 4)).toEqual([head, await rp("HEAD~1"), null, head]);
    expect(outside[resident.indexOf("v1")]).toBe(await rp("HEAD~1"));
    expect(outside[resident.length]).toBe(`^${head}`);
    expect(outside[resident.length + 1]).toBe(head);
  });

  it("resolves MERGE_HEAD during a merge and an unborn HEAD as rev-parse does", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    await r.checkout("side", { create: true });
    await r.write("b.txt", "b\n");
    await r.stage("b.txt");
    const side = await r.commit("side");
    await r.checkout("main");
    await r.git.run(["merge", "--no-ff", "--no-commit", "-q", "side"]);
    const log = await spawnLog();
    const git = await Git.open(r.root, { binary: log.binary, env: r.env });
    const merging = await answers(git, ["MERGE_HEAD", "HEAD", "side"], log);
    expect(merging.inside).toEqual(merging.outside);
    expect(merging.outside[0]).toBe(side);
    expect(merging.batches).toBe(1);

    const unborn = await repo();
    const ugit = await Git.open(unborn.root, { binary: log.binary, env: unborn.env });
    const empty = await answers(ugit, ["HEAD", "main", "MERGE_HEAD"], log);
    expect(empty.inside).toEqual([null, null, null]);
    expect(empty.outside).toEqual([null, null, null]);
    expect(empty.batches).toBe(1);
  });

  it("sees the index after git add, and a commit made through another Git", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const log = await spawnLog();
    const git = await Git.open(r.root, { binary: log.binary, env: r.env });
    const text = async () =>
      Buffer.from((await catFileBatch(git, [":0:a.txt"]))[0]?.bytes ?? []).toString("utf8");
    await withGitOperation(async () => {
      const first = await git.resolveCommit("HEAD");
      expect(await text()).toBe("a\n");
      await r.write("a.txt", "changed\n");
      await git.add(["a.txt"]);
      expect(await text()).toBe("changed\n");
      const second = await r.commit("second");
      expect(second).not.toBe(first);
      expect(await git.resolveCommit("HEAD")).toBe(second);
    });
  });

  it("falls back to one-shot commands when the resident exits early", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const log = await spawnLog();
    // The resident (the only cat-file spawned with GIT_FLUSH=1) answers one line, then exits.
    const binary = join(log.dir, "early-exit-git");
    await writeFile(
      binary,
      [
        "#!/bin/sh",
        `printf '%s %s\\n' "\${GIT_FLUSH:-0}" "$*" >> '${join(log.dir, "spawns.log")}'`,
        `case "\${GIT_FLUSH:-0} $*" in`,
        `"1 "*"cat-file --batch") head -n 1 | '${realGit()}' "$@"; exit ;;`,
        "esac",
        `exec '${realGit()}' "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(binary, 0o755);
    const git = await Git.open(r.root, { binary, env: r.env });
    const head = await r.git.resolveCommit("HEAD");
    await expect(
      withGitOperation(async () => {
        expect(await git.resolveCommit("HEAD")).toBe(head);
        for (let i = 0; i < 3; i++) {
          expect(await git.resolveCommit("HEAD")).toBe(head);
          expect((await catFileBatch(git, ["HEAD:a.txt"]))[0]?.type).toBe("blob");
        }
        throw new Error("done");
      }),
    ).rejects.toThrow("done");
    expect(await log.count(`1 ${"-c core.quotepath=off"}`)).toBe(1);
    expect(liveResidentCount()).toBe(0);
  });

  it("doesn't let an older generation's process that dies touch the current one", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const log = await spawnLog();
    const die = join(log.dir, "die");
    const flag = join(log.dir, "stopped");
    // Runs git, but its first resident cat-file stops answering at the marker, then exits 1 once
    // the `die` file appears.
    const binary = join(log.dir, "dying-git");
    await writeFile(
      binary,
      `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const real = ${JSON.stringify(realGit())};
appendFileSync(${JSON.stringify(join(log.dir, "spawns.log"))}, args.join(" ") + "\\n");
if (process.env.GIT_FLUSH === "1" && args.join(" ").endsWith("cat-file --batch")) {
  const child = spawn(real, args, { stdio: ["pipe", "inherit", "inherit"] });
  let stopped = false;
  let rest = "";
  process.stdin.on("data", (b) => {
    if (stopped) return;
    rest += b.toString("utf8");
    let eol;
    while (!stopped && (eol = rest.indexOf("\\n")) >= 0) {
      const line = rest.slice(0, eol);
      rest = rest.slice(eol + 1);
      if (line.endsWith(":__die__") && !existsSync(${JSON.stringify(flag)})) {
        writeFileSync(${JSON.stringify(flag)}, "");
        stopped = true;
        setInterval(() => {
          if (existsSync(${JSON.stringify(die)})) process.exit(1);
        }, 10);
      } else child.stdin.write(line + "\\n");
    }
  });
  process.stdin.on("end", () => {
    if (!stopped) child.stdin.end();
  });
  child.on("exit", (code) => {
    if (!stopped) process.exit(code ?? 1);
  });
} else {
  const r = spawnSync(real, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
`,
    );
    await chmod(binary, 0o755);
    const git = await Git.open(r.root, { binary, env: r.env });
    const head = (await r.git.resolveCommit("HEAD")) as string;
    await withGitOperation(async () => {
      const first = catFileBatch(git, [`${head}:__die__`]);
      await git.run(["update-ref", "refs/scratch", "HEAD"]);
      expect(await git.resolveCommit("HEAD")).toBe(head);
      await writeFile(die, "");
      expect(await first).toEqual([null]);
      expect(await git.resolveCommit("main")).toBe(head);
      expect(await git.resolveCommit("refs/scratch")).toBe(head);
    });
    expect(existsSync(flag)).toBe(true);
    expect(await log.count(BATCH)).toBe(3);
    expect(await log.count(VERIFY)).toBe(0);
    expect(liveResidentCount()).toBe(0);
  });

  it("rejects a read after end() at once", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const p = CatFileProcess.start(spawnSpec(r.git, ["cat-file", "--batch"]));
    expect(await p.read(["HEAD"])).toMatchObject([{ type: "commit" }]);
    p.end();
    await expect(p.read(["HEAD"])).rejects.toBeInstanceOf(ResidentGone);
    await p.exited;
  });
});
