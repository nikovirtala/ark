import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { UsageError } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { openIssueLog } from "./log.js";
import { IDS, issueEvent, issueFiles, opened } from "./test-support/events.js";
import {
  clearCurrentIssue,
  currentIssuePath,
  readCurrentIssue,
  setCurrentIssue,
  showCurrentIssue,
} from "./work.js";

const run = promisify(execFile);
const { A, B, C } = IDS;

async function repoWith(): Promise<TempRepo> {
  return createTempRepo({
    files: issueFiles([
      { id: A, events: [opened(A)] },
      {
        id: B,
        events: [
          { ...opened(B), at: "2026-01-01T00:00:02Z" },
          issueEvent(B, "closed", { data: { resolution: "duplicate", of: A }, reason: "same" }),
        ],
      },
      {
        id: C,
        events: [
          { ...opened(C), at: "2026-01-01T00:00:03Z" },
          issueEvent(C, "closed", { data: { resolution: "done" } }),
        ],
      },
    ]),
  });
}

const open = (repo: TempRepo, cwd = repo.root) =>
  openIssueLog({ cwd, gitOptions: { env: repo.env } });

describe("the current issue", () => {
  it("is set, shown and cleared in the git dir", async () => {
    await using repo = await repoWith();
    const log = await open(repo);
    expect(currentIssuePath(log)).toBe(join(repo.root, ".git", "issues-current"));
    const none = await showCurrentIssue(log);
    expect(none).toMatchObject({ format: "issues-work/v1", ok: true, current: null });
    expect(none.notes).toContain("no current issue");
    const set = await setCurrentIssue(log, "1");
    expect(set).toMatchObject({ ok: true, current: { id: A } });
    expect(await readFile(currentIssuePath(log), "utf8")).toBe(`${A}\n`);
    expect(await readCurrentIssue(log)).toBe(A);
    expect((await showCurrentIssue(log)).current?.id).toBe(A);
    expect(await clearCurrentIssue(log)).toMatchObject({ ok: true, current: null });
    expect(await readCurrentIssue(log)).toBeNull();
  });

  it("refuses closed issues, naming the canonical issue of a duplicate", async () => {
    await using repo = await repoWith();
    const log = await open(repo);
    await setCurrentIssue(log, A);
    const dup = await setCurrentIssue(log, B);
    expect(dup.ok).toBe(false);
    expect(dup.current?.id).toBe(A);
    expect(dup.findings.map((f) => [f.rule, f.message])).toEqual([
      ["issue/work-closed", "?2 is closed as a duplicate of ?1; work on ?1"],
    ]);
    const closed = await setCurrentIssue(log, C);
    expect(closed.findings[0]?.message).toBe("?3 is closed; reopen it before working on it");
    expect(await readCurrentIssue(log)).toBe(A);
    await expect(setCurrentIssue(log, "?9")).rejects.toThrow(UsageError);
  });

  it("ignores a file that holds no issue id, with a note", async () => {
    await using repo = await repoWith();
    const log = await open(repo);
    await writeFile(currentIssuePath(log), "not an id\n");
    expect(await readCurrentIssue(log)).toBeNull();
    const doc = await showCurrentIssue(log);
    expect(doc.current).toBeNull();
    expect(doc.notes).toContain(`ignoring ${currentIssuePath(log)}: not an issue id`);
    await writeFile(currentIssuePath(log), `${"x".repeat(70)}\n`);
    expect(await readCurrentIssue(log)).toBeNull();
  });

  it("is per worktree", async () => {
    await using repo = await repoWith();
    const wt = `${repo.root}-wt`;
    await run("git", ["worktree", "add", "-q", wt], {
      cwd: repo.root,
      env: { ...process.env, ...repo.env } as NodeJS.ProcessEnv,
    });
    try {
      const main = await open(repo);
      const linked = await open(repo, wt);
      expect(currentIssuePath(linked)).not.toBe(currentIssuePath(main));
      await setCurrentIssue(main, A);
      expect(await readCurrentIssue(linked)).toBeNull();
    } finally {
      await run("git", ["worktree", "remove", "--force", wt], {
        cwd: repo.root,
        env: { ...process.env, ...repo.env } as NodeJS.ProcessEnv,
      });
    }
  });
});
