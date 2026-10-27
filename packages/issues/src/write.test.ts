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
      `docs(issues): open "split orders"\n\nIssue: ${one.id}\nIssue-Event: opened\n`,
    );
    const two = await newIssue(r, "Second");
    const log = await open(r);
    const cases: [() => Promise<unknown>, string, string[]][] = [
      [
        () => startIssue(log, { id: "1", actor: HUMAN }, { commit: true }),
        'docs(issues): start work on ?1 "split orders"',
        ["started", "assigned"],
      ],
      [
        () =>
          stopIssue(log, { id: "1", reason: "blocked on review", actor: HUMAN }, { commit: true }),
        'docs(issues): stop work on ?1 "split orders"\n\nReason: blocked on review',
        ["stopped"],
      ],
      [
        () => commentIssue(log, { id: "1", text: "note", actor: HUMAN }, { commit: true }),
        'docs(issues): comment on ?1 "split orders"',
        ["commented"],
      ],
      [
        () =>
          labelIssue(log, { id: "1", op: { add: ["type:bug"] }, actor: HUMAN }, { commit: true }),
        'docs(issues): set the labels of ?1 "split orders"',
        ["labeled"],
      ],
      [
        () =>
          assignIssue(
            log,
            { id: "1", op: { set: ["bob@example.com"] }, actor: HUMAN },
            { commit: true },
          ),
        'docs(issues): set the assignees of ?1 "split orders"',
        ["assigned"],
      ],
      [
        () =>
          scopeIssue(log, { id: "1", op: { add: ["README.md"] }, actor: HUMAN }, { commit: true }),
        'docs(issues): set the scope of ?1 "split orders"',
        ["scoped"],
      ],
      [
        () =>
          linkIssue(log, { id: "1", to: "2", rel: "depends-on", actor: HUMAN }, { commit: true }),
        'docs(issues): link ?1 "split orders" to ?2\n\ndepends-on ?2: Second.',
        ["linked"],
      ],
      [
        () => unlinkIssue(log, { id: "1", to: "?2", actor: HUMAN }, { commit: true }),
        'docs(issues): unlink ?1 "split orders" from ?2\n\ndepends-on ?2: Second.',
        ["unlinked"],
      ],
      [
        () =>
          closeIssue(
            log,
            { id: "2", of: "1", reason: "same work", actor: HUMAN },
            { commit: true },
          ),
        'docs(issues): close ?2 "second" as a duplicate of ?1\n\nReason: same work',
        ["closed"],
      ],
      [
        () => reopenIssue(log, { id: "2", reason: "not the same", actor: HUMAN }, { commit: true }),
        'docs(issues): reopen ?2 "second"\n\nReason: not the same',
        ["reopened"],
      ],
      [
        () =>
          closeIssue(
            log,
            { id: "2", resolution: "wontfix", reason: "no", actor: HUMAN },
            { commit: true },
          ),
        'docs(issues): close ?2 "second" as won\'t fix\n\nReason: no',
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
    expect(subject).toMatch(/^docs\(issues\): open "make the order service .*…"$/);
    expect((subject ?? "").length - "docs(issues): ".length).toBeLessThanOrEqual(72);
    expect(message.replace(/\n/g, " ")).toContain(`Full title: ${title}`);
    expect(doc.notes).toContain(
      'the title was shortened to keep the commit description (after "docs(issues):") within 72 characters; the full title is in the commit body',
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
      `docs(issues): close and comment on ?1 "split orders"\n\nIssue: ${one.id}\nIssue-Event: commented\nIssue: ${one.id}\nIssue-Event: closed\n`,
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
      `docs(issues): edit ?1 "split the orders service"\n\nIssue: ${one.id}\n`,
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

describe("default commit subjects (?6)", () => {
  const trailersOf = async (r: TempRepo) =>
    (await git(r, "log", "-1", "--format=%(trailers:only,unfold)")).trim().split("\n");
  const subjectOf = async (r: TempRepo) => (await git(r, "log", "-1", "--format=%s")).trim();

  it("names a batch of staged events of other types, with one pair per issue and type", async () => {
    const r = await repo();
    const a = await newIssue(r, "Split the orders service");
    const b = await newIssue(r, "Extract the consumer");
    const c = await newIssue(r, "Move the schema");
    const log = await open(r);
    await linkIssue(log, { id: a.id, to: b.id, actor: HUMAN });
    await linkIssue(log, { id: a.id, to: c.id, rel: "depends-on", actor: HUMAN });
    await linkIssue(log, { id: a.id, to: b.id, rel: "depends-on", actor: HUMAN });
    await scopeIssue(log, { id: a.id, op: { set: ["README.md"] }, actor: HUMAN }, { commit: true });
    expect(await subjectOf(r)).toBe('docs(issues): link and scope ?1 "split the orders service"');
    expect(await trailersOf(r)).toEqual([
      `Issue: ${a.id}`,
      "Issue-Event: linked",
      `Issue: ${a.id}`,
      "Issue-Event: scoped",
    ]);

    // Two staged labels: one verb, one pair.
    await labelIssue(log, { id: b.id, op: { add: ["type:bug"] }, actor: HUMAN });
    await labelIssue(log, { id: b.id, op: { add: ["area:api"] }, actor: HUMAN }, { commit: true });
    expect(await subjectOf(r)).toBe('docs(issues): set the labels of ?2 "extract the consumer"');
    expect(await trailersOf(r)).toEqual([`Issue: ${b.id}`, "Issue-Event: labeled"]);

    // A retitle quotes the new title. edit commits the description alone (?5), so a staged
    // link of the committed issue stays staged and adds no verb.
    await linkIssue(log, { id: c.id, to: b.id, actor: HUMAN });
    await editIssue(log, { id: c.id, title: "Move the schema first" }, { commit: true });
    expect(await subjectOf(r)).toBe('docs(issues): edit ?3 "move the schema first"');
    expect(await trailersOf(r)).toEqual([`Issue: ${c.id}`]);

    // An issue opened without --commit: edit takes its staged events, edit comes first.
    const e = await newIssue(r, "Drop the old table", false);
    await linkIssue(log, { id: e.id, to: b.id, actor: HUMAN });
    await editIssue(log, { id: e.id, title: "Drop the old tables" }, { commit: true });
    expect(await subjectOf(r)).toBe(
      `docs(issues): edit, open and link ${e.id} "drop the old tables"`,
    );
    // Both events were staged, so their pairs come in path order, and two events stamped in the
    // same second sort by their random part: compare the pairs, not their order.
    const pairs = (lines: string[]) =>
      lines.flatMap((l, i) => (i % 2 === 0 ? [`${l}\n${lines[i + 1]}`] : [])).sort();
    expect(pairs(await trailersOf(r))).toEqual(
      pairs([`Issue: ${e.id}`, "Issue-Event: opened", `Issue: ${e.id}`, "Issue-Event: linked"]),
    );
  });

  it("names start with a staged assign, and keeps start's own assigned event out", async () => {
    const r = await repo();
    const a = await newIssue(r, "Split the orders service");
    const b = await newIssue(r, "Extract the consumer");
    const log = await open(r);
    await startIssue(log, { id: a.id, actor: HUMAN }, { commit: true });
    expect(await subjectOf(r)).toBe('docs(issues): start work on ?1 "split the orders service"');
    await assignIssue(log, { id: b.id, op: { add: ["ada@example.com"] }, actor: HUMAN });
    await startIssue(log, { id: b.id, actor: HUMAN }, { commit: true });
    expect(await subjectOf(r)).toBe('docs(issues): assign and start ?2 "extract the consumer"');
  });

  it("says update beyond three verbs, and names several issues", async () => {
    const r = await repo();
    const a = await newIssue(r, "Split the orders service");
    const b = await newIssue(r, "Extract the consumer");
    const log = await open(r);
    await linkIssue(log, { id: a.id, to: b.id, actor: HUMAN });
    await labelIssue(log, { id: a.id, op: { add: ["type:bug"] }, actor: HUMAN });
    await commentIssue(log, { id: a.id, text: "Noted.", actor: HUMAN });
    await scopeIssue(log, { id: a.id, op: { set: ["README.md"] }, actor: HUMAN });
    await closeIssue(log, { id: a.id, actor: HUMAN }, { commit: true });
    expect(await subjectOf(r)).toBe('docs(issues): update ?1 "split the orders service"');

    // Y opened without --commit joins X's commit: open is the one verb, so open's own subject.
    const y = await newIssue(r, "The dependency", false);
    const x = await openIssue(
      log,
      { title: "The dependent", sections: TASK, dependsOn: [y.id], actor: HUMAN },
      { commit: true },
    );
    expect(x.ok).toBe(true);
    expect(await subjectOf(r)).toBe('docs(issues): open "the dependent"');

    // An uncommitted dependency with a staged label joins: two verbs over two issues.
    const z = await newIssue(r, "Another dependency", false);
    await labelIssue(log, { id: z.id, op: { add: ["type:bug"] }, actor: HUMAN });
    const w = await openIssue(
      log,
      { title: "Another dependent", sections: TASK, dependsOn: [z.id], actor: HUMAN },
      { commit: true },
    );
    expect(await subjectOf(r)).toBe(
      `docs(issues): open and label ${w.issue?.id} and 1 other issue`,
    );
  });

  it("quotes a title with a double quote as it is", async () => {
    const r = await repo();
    await newIssue(r, 'Use the "fast" path');
    expect(await subjectOf(r)).toBe('docs(issues): open "use the "fast" path"');
  });
});

describe("composeSubject", () => {
  it("names one, two and more than 999 other issues", async () => {
    const { composeSubject } = await import("./commit-actions.js");
    const base = {
      command: "link",
      subject: "a",
      display: "?1",
      plan: [{ subject: "a", type: "linked" }],
    };
    expect(composeSubject({ ...base, extra: [{ subject: "a", type: "linked" }] })).toBeNull();
    expect(composeSubject({ ...base, extra: [{ subject: "b", type: "commented" }] })).toEqual({
      action: "link and comment on",
      name: "?1 and 1 other issue",
    });
    expect(
      composeSubject({
        ...base,
        extra: [
          { subject: "b", type: "commented" },
          { subject: "c", type: "commented" },
        ],
      }),
    ).toEqual({ action: "link and comment on", name: "?1 and 2 other issues" });
    const many = Array.from({ length: 1000 }, (_, i) => ({ subject: `s${i}`, type: "scoped" }));
    expect(composeSubject({ ...base, extra: many })).toEqual({
      action: "link and scope",
      name: "?1 and more issues",
    });
    expect(
      composeSubject({
        ...base,
        extra: ["opened", "assigned", "labeled", "scoped"].map((type) => ({ subject: "a", type })),
      }),
    ).toEqual({ action: "update", name: null });
  });
});
