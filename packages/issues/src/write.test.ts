import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type Actor, CommitFailedError, EventExistsError, UsageError } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { applyPlan } from "./apply.js";
import { openIssueLog, readIssues } from "./log.js";
import { planOpen } from "./plan.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";
import {
  assignIssue,
  closeIssue,
  commentIssue,
  editIssue,
  labelIssue,
  linkIssue,
  openIssue,
  reopenIssue,
  scopeIssue,
  startIssue,
  stopIssue,
  unlinkIssue,
} from "./write.js";

const run = promisify(execFile);
const HUMAN: Actor = {
  kind: "human",
  name: "Ledger Test",
  email: "ledger-test@example.com",
  agent: null,
  on_behalf_of: null,
};
const TASK = { goal: "Do the thing.", done: "The thing is done." };

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "x\n", ...files } });
  repos.push(r);
  return r;
}
const open = (r: TempRepo) => openIssueLog({ cwd: r.root, gitOptions: { env: r.env } });
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  const out = await run("git", args, {
    cwd: r.root,
    env: { ...process.env, ...r.env } as NodeJS.ProcessEnv,
  });
  return out.stdout;
}
const lastMessage = async (r: TempRepo) =>
  `${(await git(r, "log", "-1", "--format=%B")).trimEnd()}\n`;

async function newIssue(r: TempRepo, title = "Split orders", commit = true) {
  const doc = await openIssue(await open(r), { title, sections: TASK, actor: HUMAN }, { commit });
  if (!doc.ok || doc.issue === null) throw new Error(JSON.stringify(doc.findings));
  return doc.issue;
}

describe("writes", () => {
  it("stage without --commit", async () => {
    const r = await repo();
    const doc = await openIssue(await open(r), { title: "Staged", sections: TASK, actor: HUMAN });
    expect(doc).toMatchObject({
      format: "issues-write/v1",
      command: "new",
      ok: true,
      commit: null,
    });
    expect(doc.written).toHaveLength(3);
    const staged = (await git(r, "diff", "--cached", "--name-only")).trim().split("\n").sort();
    expect(staged).toEqual([...doc.written].sort());
  });

  it("commit with each command's subject and trailers, and number the issue on main", async () => {
    const r = await repo();
    const one = await newIssue(r, "Split orders");
    expect(one.display).toBe("?1");
    expect(await lastMessage(r)).toBe(
      `docs(issues): open split orders\n\nIssue: ${one.id}\nIssue-Event: opened\n`,
    );
    const two = await newIssue(r, "Second");
    const log = await open(r);
    const cases: [() => Promise<unknown>, string, string[]][] = [
      [
        () => startIssue(log, { id: "1", actor: HUMAN }, { commit: true }),
        "docs(issues): start work on ?1",
        ["started", "assigned"],
      ],
      [
        () =>
          stopIssue(log, { id: "1", reason: "blocked on review", actor: HUMAN }, { commit: true }),
        "docs(issues): stop work on ?1\n\nReason: blocked on review",
        ["stopped"],
      ],
      [
        () => commentIssue(log, { id: "1", text: "note", actor: HUMAN }, { commit: true }),
        "docs(issues): comment on ?1",
        ["commented"],
      ],
      [
        () =>
          labelIssue(log, { id: "1", op: { add: ["type:bug"] }, actor: HUMAN }, { commit: true }),
        "docs(issues): set the labels of ?1",
        ["labeled"],
      ],
      [
        () =>
          assignIssue(
            log,
            { id: "1", op: { set: ["bob@example.com"] }, actor: HUMAN },
            { commit: true },
          ),
        "docs(issues): set the assignees of ?1",
        ["assigned"],
      ],
      [
        () =>
          scopeIssue(log, { id: "1", op: { add: ["README.md"] }, actor: HUMAN }, { commit: true }),
        "docs(issues): set the scope of ?1",
        ["scoped"],
      ],
      [
        () =>
          linkIssue(log, { id: "1", to: "2", rel: "depends-on", actor: HUMAN }, { commit: true }),
        "docs(issues): link ?1 to ?2\n\ndepends-on ?2: Second.",
        ["linked"],
      ],
      [
        () => unlinkIssue(log, { id: "1", to: "?2", actor: HUMAN }, { commit: true }),
        "docs(issues): unlink ?1 to ?2\n\ndepends-on ?2: Second.",
        ["unlinked"],
      ],
      [
        () =>
          closeIssue(
            log,
            { id: "2", of: "1", reason: "same work", actor: HUMAN },
            { commit: true },
          ),
        "docs(issues): close ?2 as a duplicate of ?1\n\nReason: same work",
        ["closed"],
      ],
      [
        () => reopenIssue(log, { id: "2", reason: "not the same", actor: HUMAN }, { commit: true }),
        "docs(issues): reopen ?2\n\nReason: not the same",
        ["reopened"],
      ],
      [
        () =>
          closeIssue(
            log,
            { id: "2", resolution: "wontfix", reason: "no", actor: HUMAN },
            { commit: true },
          ),
        "docs(issues): close ?2 as won't fix\n\nReason: no",
        ["closed"],
      ],
    ];
    for (const [f, subject, types] of cases) {
      const doc = (await f()) as {
        ok: boolean;
        commit: string | null;
        issue: { id: string } | null;
      };
      expect(doc.ok, subject).toBe(true);
      expect(doc.commit, subject).not.toBeNull();
      const id = doc.issue?.id ?? "";
      const trailers = types.map((t) => `Issue: ${id}\nIssue-Event: ${t}`).join("\n");
      expect(await lastMessage(r), subject).toBe(`${subject}\n\n${trailers}\n`);
    }
    expect(two.id).not.toBe(one.id);
  });

  it("shortens a long title in the subject and puts the full title in the body", async () => {
    const r = await repo();
    const title = "Make the order service split its read and write paths into two deployables";
    const doc = await openIssue(
      await open(r),
      { title, sections: TASK, actor: HUMAN },
      { commit: true },
    );
    const message = await lastMessage(r);
    const [subject] = message.split("\n");
    expect((subject ?? "").length).toBeLessThanOrEqual(86);
    expect(subject).toMatch(/…$/);
    expect(message.replace(/\n/g, " ")).toContain(`Full title: ${title}`);
    expect(doc.notes).toContain(
      "commit subject shortened to 72 characters; the full title is in the commit body",
    );
  });

  it("merges the trailers into -m's own trailer block", async () => {
    const r = await repo();
    const one = await newIssue(r);
    await commentIssue(
      await open(r),
      { id: one.id, text: "x", actor: HUMAN },
      { commit: true, message: "chore: note it\n\nRefs: #1" },
    );
    expect(await lastMessage(r)).toBe(
      `chore: note it\n\nRefs: #1\nIssue: ${one.id}\nIssue-Event: commented\n`,
    );
  });

  it("commits an event without an unstaged description edit, and leaves other staged work staged", async () => {
    const r = await repo();
    const one = await newIssue(r);
    const body = one.body_path ?? "";
    await r.write(body, "# Split orders\n\nlocal edit\n");
    await r.write("other.txt", "other\n");
    await r.stage("other.txt");
    const doc = await closeIssue(await open(r), { id: one.id, actor: HUMAN }, { commit: true });
    expect(doc.ok).toBe(true);
    const files = (await git(r, "show", "--name-only", "--format=", "HEAD")).trim().split("\n");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/closed\.yaml$/);
    expect((await git(r, "status", "--porcelain")).split("\n").sort()).toEqual(
      ["", "A  other.txt", ` M ${body}`].sort(),
    );
  });

  it("refuses a commit when the events directory has an untracked event", async () => {
    const r = await repo();
    const one = await newIssue(r);
    const log = await open(r);
    const stray = `docs/issues/events/${one.id}/20990101T000000Z-aaaa-commented.yaml`;
    await r.write(stray, "x: 1\n");
    const err = await commentIssue(
      log,
      { id: one.id, text: "x", actor: HUMAN },
      { commit: true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toBe(
      `${stray} is not tracked; git add it, or run without --commit`,
    );
  });

  it("joins already-staged events of the issue to the commit, with their trailers", async () => {
    const r = await repo();
    const one = await newIssue(r);
    await commentIssue(await open(r), { id: one.id, text: "staged first", actor: HUMAN });
    await closeIssue(await open(r), { id: one.id, actor: HUMAN }, { commit: true });
    expect(await lastMessage(r)).toBe(
      `docs(issues): close ?1\n\nIssue: ${one.id}\nIssue-Event: commented\nIssue: ${one.id}\nIssue-Event: closed\n`,
    );
  });

  it("removes what it wrote when a write fails", async () => {
    const r = await repo();
    const log = await open(r);
    const read = await readIssues(log);
    const c = {
      now: Date.now,
      templates: {
        get: async () => ({ ok: false as const, reason: "not-found" as const, path: "x" }),
      },
      builtins: BUILTIN_TEMPLATES,
    };
    const p = await planOpen(read, { title: "Broken", sections: TASK, actor: HUMAN }, c);
    if (!p.ok) throw new Error("plan");
    const [first] = p.plan.events;
    const broken = { ...p.plan, events: [{ ...first, data: {} } as typeof first & object] };
    await expect(applyPlan(log, broken, { commit: false })).rejects.toThrow();
    expect((await git(r, "status", "--porcelain")).trim()).toBe("");
  });

  it("retries once on EventExistsError", async () => {
    const r = await repo();
    const one = await newIssue(r);
    let calls = 0;
    const doc = await commentIssue(
      await open(r),
      { id: one.id, text: "x", actor: HUMAN },
      {},
      {
        now: Date.now,
        apply: async (...args) => {
          calls++;
          if (calls === 1) throw new EventExistsError("docs/issues/events/x.yaml");
          return applyPlan(...args);
        },
      },
    );
    expect(doc.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("throws CommitFailedError with the recovery hint when git commit fails", async () => {
    const r = await repo();
    const one = await newIssue(r);
    const hook = join(r.git.gitDir, "hooks", "pre-commit");
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, "#!/bin/sh\necho no >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const err = await commentIssue(
      await open(r),
      { id: one.id, text: "x", actor: HUMAN },
      { commit: true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitFailedError);
    expect((await git(r, "diff", "--cached", "--name-only")).trim()).toMatch(/commented\.yaml$/);
  });

  it("refuses to commit an incomplete draft without an editor, writing nothing", async () => {
    const r = await repo();
    const doc = await openIssue(await open(r), { title: "Draft", actor: HUMAN }, { commit: true });
    expect(doc.ok).toBe(false);
    expect(doc.written).toEqual([]);
    expect(doc.findings.map((f) => f.rule)).toContain("template/guidance-left");
    expect((await git(r, "status", "--porcelain")).trim()).toBe("");
  });

  it("materializes a built-in template on first use", async () => {
    const r = await repo();
    const doc = await openIssue(
      await open(r),
      {
        title: "Crash",
        template: "bug",
        sections: { summary: "s", reproduce: "r", expected: "e", actual: "a", done: "d" },
        actor: HUMAN,
      },
      { commit: true },
    );
    expect(doc.written).toContain("docs/issues/templates/bug.md");
    expect(await readFile(join(r.root, "docs/issues/templates/bug.md"), "utf8")).toBe(
      BUILTIN_TEMPLATES.bug,
    );
  });

  it("edits the title and sections, committing the body only", async () => {
    const r = await repo();
    const one = await newIssue(r);
    const doc = await editIssue(
      await open(r),
      { id: "1", title: "Split the orders service", sections: { goal: "Two services." } },
      { commit: true },
    );
    expect(doc.ok).toBe(true);
    expect(doc.issue?.title).toBe("Split the orders service");
    expect(await lastMessage(r)).toBe(
      `docs(issues): edit the description of ?1\n\nIssue: ${one.id}\n`,
    );
    expect((await git(r, "show", "--name-only", "--format=", "HEAD")).trim()).toBe(one.body_path);
    const again = await editIssue(await open(r), { id: "1", title: "Split the orders service" });
    expect(again.notes).toContain("nothing changed");
    await expect(editIssue(await open(r), { id: "1" })).rejects.toThrow(
      "no editor: set VISUAL or EDITOR",
    );
  });

  it("edits with an editor and commits the body", async () => {
    const r = await repo();
    const one = await newIssue(r);
    const doc = await editIssue(
      await open(r),
      { id: one.id },
      {
        commit: true,
        edit: async (abs) => {
          await writeFile(abs, `${await readFile(abs, "utf8")}\nMore.\n`);
          return null;
        },
      },
    );
    expect(doc.written).toEqual([one.body_path]);
    expect(doc.commit).not.toBeNull();
    const unchanged = await editIssue(await open(r), { id: one.id }, { edit: async () => null });
    expect(unchanged.notes).toContain("nothing changed");
  });

  it("commits with [policy] auto_commit", async () => {
    const r = await repo({ "docs/issues/issues.toml": "[policy]\nauto_commit = true\n" });
    const doc = await openIssue(await open(r), { title: "Auto", sections: TASK, actor: HUMAN });
    expect(doc.commit).not.toBeNull();
  });

  it("refuses writes on a --ref log", async () => {
    const r = await repo();
    const log = await openIssueLog({ cwd: r.root, ref: "HEAD", gitOptions: { env: r.env } });
    await expect(openIssue(log, { title: "x", actor: HUMAN })).rejects.toThrow(
      "writes read the work tree",
    );
  });
});
