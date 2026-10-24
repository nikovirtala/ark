import { execFile } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CommitFailedError, type CommitRecovery, GitError, LedgerError } from "../errors.js";
import { commitMessageText, Git, type Trailer } from "../git/git.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { commitWithRecovery, saveCommitRecovery } from "./commit-recovery.js";

const run = promisify(execFile);

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "# r\n" } });
  repos.push(r);
  return r;
}

const RERUN = "Don't run the command again: it would write it a second time.";
const recovery = (o: Partial<CommitRecovery> = {}): CommitRecovery => ({
  staged: ["log/a.yaml", "log/index.md"],
  messageFile: "/r/.git/ark/COMMIT_MSG",
  command: "git -C /r commit --cleanup=whitespace -F /r/.git/ark/COMMIT_MSG --only -- log/a.yaml",
  trailers: [["ADR", "k3f9q8a1"]],
  ...o,
});
const error = (o: Partial<ConstructorParameters<typeof CommitFailedError>[0]> = {}) =>
  new CommitFailedError({
    recovery: recovery(),
    headline: "git commit failed (exit 1): hook says no",
    detail: "  hook says no",
    rerun: RERUN,
    before: null,
    after: null,
    ...o,
  });

describe("CommitFailedError", () => {
  it("lays out the hint: what failed, what is staged, the command and the trailers", () => {
    const e = error();
    expect(e).toBeInstanceOf(LedgerError);
    expect(e).toMatchObject({ name: "CommitFailedError", code: "commit-failed", rerun: RERUN });
    expect(e.recovery).toEqual(recovery());
    expect(e.message).toBe(
      [
        "git commit failed (exit 1): hook says no",
        "  hook says no",
        `The files are written and staged. ${RERUN} Staged for this commit:`,
        "  log/a.yaml",
        "  log/index.md",
        "Fix what made git fail, then commit exactly these files with the message adr prepared:",
        `  ${recovery().command}`,
        "The message ends with these trailers; keep them if you edit the file:",
        "  ADR: k3f9q8a1",
      ].join("\n"),
    );
  });

  it("lists several trailers, or says there are none", () => {
    const several = error({
      recovery: recovery({
        trailers: [
          ["ADR", "k3f9q8a1"],
          ["ADR-Event", "accepted"],
        ],
      }),
    });
    expect(several.message).toMatch(
      /keep them if you edit the file:\n {2}ADR: k3f9q8a1\n {2}ADR-Event: accepted$/,
    );
    const none = error({ recovery: recovery({ trailers: [] }) });
    expect(none.message.split("\n").at(-1)).toBe("The message has no trailers.");
    expect(none.message).not.toContain("keep them");
  });

  it("puts before ahead of the command with its own lead-in, and after last", () => {
    const e = error({
      headline: "log/index.md couldn't be refreshed: disk full",
      detail: "",
      before: "Run adr index --no-commit first.",
      after: "Then run adr index --no-commit.",
    });
    const lines = e.message.split("\n");
    expect(lines[0]).toBe("log/index.md couldn't be refreshed: disk full");
    expect(lines[1]).toBe(`The files are written and staged. ${RERUN} Staged for this commit:`);
    expect(lines.slice(4, 6)).toEqual([
      "Run adr index --no-commit first.",
      "Then commit exactly these files with the message adr prepared:",
    ]);
    expect(lines.at(-1)).toBe("Then run adr index --no-commit.");
    expect(lines.at(-2)).toBe("  ADR: k3f9q8a1");
    expect(error().message).not.toContain("Then run");
  });
});

describe("saveCommitRecovery", () => {
  it("quotes paths sh can't take as they are", async () => {
    const r = await repo();
    const rec = await saveCommitRecovery(r.git, { message: "m\n", only: ["b c.txt", "a.txt"] });
    const file = join(r.git.gitDir, "ark", "COMMIT_MSG");
    expect(rec).toEqual({
      staged: ["a.txt", "b c.txt"],
      messageFile: file,
      command: `git -C ${r.root} commit --cleanup=whitespace -F ${file} --only -- a.txt 'b c.txt'`,
      trailers: [],
    });
  });

  it("reads paths literally when one holds a pathspec character", async () => {
    const r = await repo();
    for (const [path, word] of [
      ["c[1].txt", "'c[1].txt'"],
      ["*.txt", "'*.txt'"],
      [":top.txt", ":top.txt"],
    ] as const) {
      const rec = await saveCommitRecovery(r.git, { message: "m\n", only: [path] });
      expect(rec.command).toMatch(/^git --literal-pathspecs -C /);
      expect(rec.command.endsWith(` -- ${word}`)).toBe(true);
    }
    const plain = await saveCommitRecovery(r.git, { message: "m\n", only: ["a.txt"] });
    expect(plain.command).toMatch(/^git -C /);
  });
});

/** Splits a command made of plain and single-quoted sh words. */
function shWords(command: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === " ") {
      if (cur !== null) words.push(cur);
      cur = null;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      cur = (cur ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (c === "\\") {
      cur = (cur ?? "") + (command[++i] ?? "");
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (cur !== null) words.push(cur);
  return words;
}

const hermetic = (r: TempRepo) =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...r.env }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

async function failingHook(r: TempRepo, script: string): Promise<string> {
  const path = join(r.git.gitDir, "hooks", "pre-commit");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

const out = async (r: TempRepo, args: string[]) =>
  Buffer.from((await r.git.run(args)).stdout).toString();

describe("commitWithRecovery", () => {
  const trailers: Trailer[] = [
    ["ADR", "k3f9q8a1"],
    ["ADR-Event", "accepted"],
  ];
  const message = "docs(adr): accept a thing\n\nWhy it matters.\n";

  it("saves the message and prints a command that commits exactly the paths", async () => {
    const r = await repo();
    const only = ["log/a b.yaml", "log/c[1].md"];
    await r.writeFiles({ "log/a b.yaml": "a\n", "log/c[1].md": "c\n", "other.txt": "o\n" });
    await r.stage(...only, "other.txt");
    const hook = await failingHook(r, 'echo "hook says no" >&2; exit 1');
    const head = await r.git.resolveCommit("HEAD");
    const e = await commitWithRecovery(r.git, { message, trailers, only, rerun: RERUN }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(CommitFailedError);
    const failed = e as CommitFailedError;
    expect(failed.cause).toBeInstanceOf(GitError);
    expect(failed.message.split("\n").slice(0, 2)).toEqual([
      "git commit failed (exit 1): hook says no",
      "  hook says no",
    ]);
    expect(failed.message).toContain(RERUN);
    expect(failed.message.split("\n").at(-1)).toBe("  ADR-Event: accepted");
    expect(await r.git.resolveCommit("HEAD")).toBe(head);
    const saved = await readFile(failed.recovery.messageFile, "utf8");
    expect(saved).toBe(commitMessageText(message, trailers));

    await rm(hook);
    const [bin, ...args] = shWords(failed.recovery.command);
    expect(bin).toBe("git");
    await run("git", args, { cwd: "/", env: hermetic(r) });
    expect(await out(r, ["log", "-1", "--format=%B"])).toBe(`${saved}\n`);
    expect(await out(r, ["log", "-1", "--format=%(trailers:only,unfold)"])).toBe(
      "ADR: k3f9q8a1\nADR-Event: accepted\n\n",
    );
    expect(await r.git.changedPaths(head, { commit: "HEAD" })).toEqual(only);
    expect(await r.git.stagedPaths(["other.txt"])).toEqual(["other.txt"]);
  });

  it("keeps the first 40 lines of git's stderr", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.stage("a.txt");
    await failingHook(
      r,
      'i=1; while [ $i -le 50 ]; do echo "line $i" >&2; i=$((i+1)); done; exit 3',
    );
    const e = (await commitWithRecovery(r.git, {
      message: "m\n",
      only: ["a.txt"],
      rerun: RERUN,
      after: "Then run tool index.",
    }).catch((x: unknown) => x)) as CommitFailedError;
    const lines = e.message.split("\n");
    expect(lines[0]).toBe("git commit failed (exit 1): line 1");
    expect(lines.slice(1, 42)).toEqual([
      ...Array.from({ length: 40 }, (_, i) => `  line ${i + 1}`),
      "  …",
    ]);
    expect(lines.at(-2)).toBe("The message has no trailers.");
    expect(lines.at(-1)).toBe("Then run tool index.");
  });

  it("rethrows git's error when HEAD moved despite the failure", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.stage("a.txt");
    const binary = join(r.git.gitDir, "git-wrapper");
    await writeFile(
      binary,
      '#!/bin/sh\ngit "$@"; s=$?\ncase " $* " in *" commit "*) echo "post-commit failed" >&2; exit 1;; esac\nexit $s\n',
    );
    await chmod(binary, 0o755);
    const wrapped = await Git.open(r.root, { ...r.git.options, binary });
    const e = await commitWithRecovery(wrapped, {
      message: "m\n",
      only: ["a.txt"],
      rerun: RERUN,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitError);
    expect(e).not.toBeInstanceOf(CommitFailedError);
  });

  it("rethrows git's error with the fs error as cause when the message can't be saved", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.stage("a.txt");
    await failingHook(r, "exit 1");
    await writeFile(join(r.git.gitDir, "ark"), "not a directory\n");
    const e = await commitWithRecovery(r.git, {
      message: "m\n",
      only: ["a.txt"],
      rerun: RERUN,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitError);
    expect(e).not.toBeInstanceOf(CommitFailedError);
    expect((e as GitError).exitCode).toBe(1);
    expect((e as GitError).cause).toMatchObject({ code: expect.stringMatching(/EEXIST|ENOTDIR/) });
  });

  it("returns the new sha when the commit succeeds", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.stage("a.txt");
    const sha = await commitWithRecovery(r.git, { message: "m\n", only: ["a.txt"], rerun: RERUN });
    expect(sha).toBe(await r.git.resolveCommit("HEAD"));
  });
});
