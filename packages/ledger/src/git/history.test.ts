import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidArgumentError, RefNotFoundError } from "../errors.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import type { Trailer } from "./git.js";
import { firstParentAdditions, firstParentHistory, parseTrailerBlock } from "./history.js";

const repos: TempRepo[] = [];

afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

async function commitFile(r: TempRepo, path: string, content: string, message: string) {
  await r.write(path, content);
  await r.stage(path);
  return r.commit(message);
}

function hasSshKeygen(): boolean {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

describe("firstParentHistory", () => {
  it("returns commit trailers unchanged", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.stage("a.txt");
    const trailers: Trailer[] = [
      ["ADR", "12"],
      ["ADR-Event", "accepted"],
      ["Issue", "m4p8x2kd"],
    ];
    const sha = await r.git.commit({ message: "docs: accept adr 12\n\nbody text\n", trailers });
    const [info] = await firstParentHistory(r.git, "HEAD");
    expect(info).toMatchObject({ sha, parents: [], subject: "docs: accept adr 12", trailers });
    expect(info?.authorDate).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("leaves out commits reached only through a merge's second parent", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const base = await r.git.resolveCommit("HEAD");
    await r.checkout("topic", { create: true });
    const t1 = await commitFile(r, "t1.txt", "1\n", "topic 1");
    const t2 = await commitFile(r, "t2.txt", "2\n", "topic 2");
    await r.checkout("main");
    const m1 = await commitFile(r, "m.txt", "m\n", "main 1");
    const merge = await r.merge("topic", { noFf: true, message: "merge topic" });

    const history = await firstParentHistory(r.git, "main");
    expect(history.map((c) => c.sha)).toEqual([merge, m1, base]);
    expect(history[0]?.parents).toEqual([m1, t2]);
    expect(history.map((c) => c.sha)).not.toContain(t1);
    const oldest = await firstParentHistory(r.git, "main", { order: "oldest-first" });
    expect(oldest.map((c) => c.sha)).toEqual([base, m1, merge]);
    const touching = await firstParentHistory(r.git, "main", { paths: ["m.txt"] });
    expect(touching.map((c) => c.sha)).toEqual([m1]);
  });

  it("throws RefNotFoundError for an unknown ref or an unborn HEAD", async () => {
    const unborn = await repo();
    await expect(firstParentHistory(unborn.git, "HEAD")).rejects.toBeInstanceOf(RefNotFoundError);
    await expect(firstParentAdditions(unborn.git, "HEAD", "")).rejects.toBeInstanceOf(
      RefNotFoundError,
    );
    await expect(firstParentHistory(unborn.git, "-x")).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("works on a bare repository", async () => {
    const src = await repo({ files: { "a.txt": "a\n" } });
    const bare = await repo({ bare: true });
    await src.git.run(["push", "-q", bare.root, "main"]);
    const history = await firstParentHistory(bare.git, "main");
    expect(history.map((c) => c.subject)).toEqual(["initial"]);
  });

  it.skipIf(!hasSshKeygen())(
    "parses signed commits with log.showSignature=true (skipped without ssh-keygen)",
    async () => {
      const r = await repo();
      const key = join(r.root, "..", "signing-key");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "ledger", "-f", key]);
      const pub = readFileSync(`${key}.pub`, "utf8").trim();
      const allowed = join(r.root, "..", "allowed-signers");
      writeFileSync(allowed, `ledger-test@example.com ${pub}\n`);
      for (const [k, v] of [
        ["gpg.format", "ssh"],
        ["user.signingkey", key],
        ["gpg.ssh.allowedSignersFile", allowed],
        ["commit.gpgsign", "true"],
        ["log.showSignature", "true"],
      ] as const) {
        await r.git.run(["config", k, v]);
      }
      await r.write("a.txt", "a\n");
      await r.stage("a.txt");
      const sha = await r.git.commit({ message: "signed", trailers: [["Issue", "m4p8x2kd"]] });
      // Without the override, the signature check lands in --format stdout.
      const raw = await r.git.run(["-c", "log.showSignature=true", "log", "-1", "--format=%H"]);
      expect(Buffer.from(raw.stdout).toString()).toMatch(/Good "git" signature/);
      const history = await firstParentHistory(r.git, "HEAD");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        sha,
        subject: "signed",
        trailers: [["Issue", "m4p8x2kd"]],
      });
    },
  );
});

describe("firstParentAdditions", () => {
  it("returns the first-parent commit that first added each path, oldest first", async () => {
    const r = await repo();
    const c1 = await commitFile(r, "log/b.txt", "b\n", "add b");
    const c2 = await commitFile(r, "log/a.txt", "a\n", "add a");
    await commitFile(r, "log/a.txt", "a2\n", "edit a");
    await commitFile(r, "other.txt", "o\n", "outside");
    await r.checkout("topic", { create: true });
    await commitFile(r, "log/t.txt", "t\n", "add t on topic");
    await r.checkout("main");
    const merge = await r.merge("topic", { noFf: true });
    await r.remove("log/b.txt");
    await r.commit("delete b", { all: true });
    const c5 = await commitFile(r, "log/b.txt", "b again\n", "re-add b");

    expect(await firstParentAdditions(r.git, "main", "log")).toEqual([
      { path: "log/b.txt", commit: c1 },
      { path: "log/a.txt", commit: c2 },
      { path: "log/t.txt", commit: merge },
    ]);
    expect(c5).not.toBe(c1);
  });

  it("reports a moved file as an addition even with diff.renames=true", async () => {
    const r = await repo();
    await r.git.run(["config", "diff.renames", "true"]);
    await commitFile(r, "log/old.txt", "same content\n", "add");
    await r.git.run(["mv", "log/old.txt", "log/new.txt"]);
    const moved = await r.commit("move");
    const additions = await firstParentAdditions(r.git, "HEAD", "log/");
    expect(additions.find((a) => a.path === "log/new.txt")).toEqual({
      path: "log/new.txt",
      commit: moved,
    });
  });
});

describe("parseTrailerBlock", () => {
  it("parses Key: value lines and skips others", () => {
    expect(parseTrailerBlock("ADR: 12\nnot a trailer\nIssue:  m4p8x2kd  \n\n")).toEqual([
      ["ADR", "12"],
      ["Issue", "m4p8x2kd"],
    ]);
  });

  it("round-trips formatted trailers", () => {
    const key = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,15}$/);
    const value = fc
      .string({ unit: fc.constantFrom("a", "Z", "0", " ", ":", "-", "#", "é", "\t") })
      .map((s) => s.trim());
    fc.assert(
      fc.property(fc.array(fc.tuple(key, value), { maxLength: 6 }), (trailers) => {
        const text = trailers.map(([k, v]) => `${k}: ${v}\n`).join("");
        expect(parseTrailerBlock(text)).toEqual(trailers);
      }),
    );
  });
});
