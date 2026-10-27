import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "../templates/builtin.js";
import { cliEnv, cliRepo, newIssue, runIssues, runJson, TASK_FLAGS } from "../test-support/cli.js";

type Write = { ok?: boolean; issue: { id: string } | null; written: string[] };

const TEMPLATE = "docs/issues/templates/task.md";

const git = (repo: TempRepo, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo.root, env: cliEnv(repo), encoding: "utf8" });

/** The files of the `HEAD` commit, sorted. */
const files = (repo: TempRepo): string[] =>
  git(repo, "show", "--name-only", "--format=", "HEAD")
    .split("\n")
    .filter((l) => l !== "")
    .sort();

const status = (repo: TempRepo): string => git(repo, "status", "--porcelain");
const head = (repo: TempRepo): string => git(repo, "rev-parse", "HEAD").trim();
const sorted = (...xs: (readonly string[])[]): string[] => [...new Set(xs.flat())].sort();

function verifiesAtHead(repo: TempRepo): void {
  const r = runIssues(repo, ["verify", "--ref", "HEAD"]);
  expect(r.stdout + r.stderr).toContain("No findings");
  expect(r.status).toBe(0);
}

/** Runs a write with `--json`, expecting it to succeed; its written paths. */
function write(repo: TempRepo, args: readonly string[], env?: NodeJS.ProcessEnv): string[] {
  const r = runJson<Write>(repo, args, env === undefined ? {} : { env });
  if (r.status !== 0 || r.json.ok === false)
    throw new Error(`${args[0]} failed: ${r.stdout}${r.stderr}`);
  return r.json.written;
}

/** `issues new <title>` without `--commit`, with the task sections unless `extra` gives some. */
function stageNew(
  repo: TempRepo,
  title: string,
  extra: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): { id: string; written: string[]; body: string; opened: string } {
  const flags = extra.includes("--section") ? extra : [...TASK_FLAGS, ...extra];
  const r = runJson<Write>(repo, ["new", title, ...flags], env === undefined ? {} : { env });
  if (r.status !== 0 || r.json.issue === null)
    throw new Error(`new failed: ${r.stdout}${r.stderr}`);
  const body = r.json.written.find((p) => p.includes("/items/")) ?? "";
  const opened = r.json.written.find((p) => p.endsWith("-opened.yaml")) ?? "";
  return { id: r.json.issue.id, written: r.json.written, body, opened };
}

/** Expects a `--commit` refusal with `message`, and that nothing was written or committed. */
function refuses(repo: TempRepo, args: readonly string[], message: string): void {
  const before = { status: status(repo), head: head(repo) };
  const r = runIssues(repo, args);
  expect(r.stderr).toContain(message);
  expect(r.status).toBe(2);
  expect({ status: status(repo), head: head(repo) }).toEqual(before);
}

describe("--commit with staged descriptions", () => {
  it("commits the staged description with the opened event (?5's steps)", async () => {
    await using repo = await cliRepo();
    const env = { ARK_AGENT: "kiro" };
    write(repo, ["init", "--commit"], env);
    const a = stageNew(
      repo,
      "Split the orders service",
      ["--section", "goal=x", "--section", "done=y"],
      env,
    );
    const scoped = write(repo, ["scope", a.id, "--set", "src/**"], env);
    await writeFile(join(repo.root, "other.txt"), "other\n");
    git(repo, "add", "other.txt");
    // A different issue's commit leaves A's staged files staged (a′).
    write(repo, ["new", "Another", ...TASK_FLAGS, "--commit"], env);
    expect(
      status(repo)
        .split("\n")
        .filter((l) => l !== "")
        .sort(),
    ).toEqual(
      sorted(
        ["A  other.txt"],
        [...a.written, ...scoped].map((p) => `A  ${p}`),
      ),
    );
    const commented = write(repo, ["comment", a.id, "first", "--commit"], env);
    expect(files(repo)).toEqual(sorted(a.written, scoped, commented));
    expect(files(repo)).toContain(a.body);
    expect(status(repo)).toBe("A  other.txt\n");
    verifiesAtHead(repo);
  });

  it("commits new, link, then scope --commit as in PR #22", async () => {
    await using repo = await cliRepo();
    const b = newIssue(repo, "B");
    const a = stageNew(repo, "A");
    const linked = write(repo, ["link", a.id, b, "--rel", "depends-on"]);
    const scoped = write(repo, ["scope", a.id, "--set", "src/**", "--commit"]);
    expect(files(repo)).toEqual(sorted(a.written, linked, scoped));
    expect(files(repo)).toContain(a.body);
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  const LATER: Readonly<Record<string, (id: string, other: string) => string[]>> = {
    comment: (id) => ["comment", id, "x"],
    scope: (id) => ["scope", id, "--set", "src/**"],
    label: (id) => ["label", id, "--add", "bug"],
    assign: (id) => ["assign", id, "--set", "someone@example.com"],
    start: (id) => ["start", id],
    close: (id) => ["close", id],
    link: (id, other) => ["link", id, other],
  };
  it.each(Object.keys(LATER))("takes the description with a later %s --commit", async (cmd) => {
    await using repo = await cliRepo();
    const other = newIssue(repo, "Other");
    const a = stageNew(repo, "A");
    const later = write(repo, [...(LATER[cmd]?.(a.id, other) ?? []), "--commit"]);
    expect(files(repo)).toEqual(sorted(a.written, later));
    expect(files(repo)).toContain(a.body);
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  it("leaves a staged edit of a committed issue's description staged", async () => {
    await using repo = await cliRepo();
    const a = newIssue(repo, "A");
    const [body = ""] = write(repo, ["edit", a, "--section", "goal=Changed."]);
    const commented = write(repo, ["comment", a, "x", "--commit"]);
    expect(files(repo)).toEqual(sorted(commented));
    expect(status(repo)).toBe(`M  ${body}\n`);
    verifiesAtHead(repo);
  });

  it("commits the edited staged description of an issue opened without --commit", async () => {
    await using repo = await cliRepo();
    const a = stageNew(repo, "A");
    write(repo, ["edit", a.id, "--section", "goal=Edited."]);
    const commented = write(repo, ["comment", a.id, "x", "--commit"]);
    expect(files(repo)).toEqual(sorted(a.written, commented));
    const committed = git(repo, "show", `HEAD:${a.body}`);
    expect(committed).toContain("Edited.");
    expect(committed).toBe(await readFile(join(repo.root, a.body), "utf8"));
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  it("refuses an unstaged edit of a description the commit needs, writing nothing", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Other");
    const a = stageNew(repo, "A");
    await appendFile(join(repo.root, a.body), "\nMore.\n");
    refuses(
      repo,
      ["comment", a.id, "x", "--commit"],
      `${a.body} has unstaged changes; stage or discard them, or run without --commit`,
    );
  });

  it("commits a staged-only link target with the link", async () => {
    await using repo = await cliRepo();
    const a = newIssue(repo, "A");
    const b = stageNew(repo, "B");
    const linked = write(repo, ["link", a, b.id, "--commit"]);
    expect(files(repo)).toEqual(sorted(b.written, linked));
    expect(files(repo)).toContain(b.body);
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  it("commits a staged-only duplicate-of target with the close", async () => {
    await using repo = await cliRepo();
    const a = newIssue(repo, "A");
    const b = stageNew(repo, "B");
    const closed = write(repo, [
      "close",
      a,
      "--resolution",
      "duplicate",
      "--duplicate-of",
      b.id,
      "--reason",
      "dup",
      "--commit",
    ]);
    expect(files(repo)).toEqual(sorted(b.written, closed));
    expect(files(repo)).toContain(b.body);
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  it("follows references from issues the commit takes", async () => {
    await using repo = await cliRepo();
    const a = newIssue(repo, "A");
    const c = stageNew(repo, "C");
    const b = stageNew(repo, "B", ["--depends-on", c.id]);
    const linked = write(repo, ["link", a, b.id, "--commit"]);
    expect(files(repo)).toEqual(sorted(c.written, b.written, linked));
    expect(files(repo)).toEqual(expect.arrayContaining([b.body, c.body]));
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  it("leaves a committed link target's staged events staged", async () => {
    await using repo = await cliRepo();
    const a = newIssue(repo, "A");
    const b = newIssue(repo, "B");
    const [comment = ""] = write(repo, ["comment", b, "x"]);
    const linked = write(repo, ["link", a, b, "--commit"]);
    expect(files(repo)).toEqual(sorted(linked));
    expect(status(repo)).toBe(`A  ${comment}\n`);
    verifiesAtHead(repo);
  });

  it.each(["--depends-on", "--parent"])(
    "commits a staged-only dependency with new %s --commit",
    async (flag) => {
      await using repo = await cliRepo();
      const b = stageNew(repo, "B");
      const a = write(repo, ["new", "A", ...TASK_FLAGS, flag, b.id, "--commit"]);
      expect(files(repo)).toEqual(sorted(b.written, a));
      expect(files(repo)).toEqual(expect.arrayContaining([b.body, TEMPLATE]));
      expect(status(repo)).toBe("");
      verifiesAtHead(repo);
    },
  );

  it("leaves init's config staged and commits the template the issue uses", async () => {
    await using repo = await cliRepo();
    const init = write(repo, ["init"]);
    expect(init).toContain("docs/issues/issues.toml");
    expect(init).toContain(TEMPLATE);
    const a = stageNew(repo, "A");
    const commented = write(repo, ["comment", a.id, "x", "--commit"]);
    expect(files(repo)).toEqual(sorted(a.written, [TEMPLATE], commented));
    expect(status(repo)).toBe(
      init
        .filter((p) => p !== TEMPLATE)
        .sort()
        .map((p) => `A  ${p}\n`)
        .join(""),
    );
    verifiesAtHead(repo);
  });

  it("refuses an untracked template the commit needs, then commits it once added", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Other");
    const team = "docs/issues/templates/team.md";
    await writeFile(
      join(repo.root, team),
      (BUILTIN_TEMPLATES.task ?? "").replace("template: task", "template: team"),
    );
    const a = stageNew(repo, "A", ["--template", "team"]);
    expect(a.written).not.toContain(team);
    refuses(
      repo,
      ["comment", a.id, "x", "--commit"],
      `${team} is not tracked; git add it, or run without --commit`,
    );
    git(repo, "add", team);
    const commented = write(repo, ["comment", a.id, "x", "--commit"]);
    expect(files(repo)).toEqual(sorted(a.written, [team], commented));
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  it("edit --commit takes the staged events of an issue opened without --commit", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Other");
    const a = stageNew(repo, "A");
    write(repo, ["edit", a.id, "--section", "goal=Edited.", "--commit"]);
    expect(files(repo)).toEqual(sorted(a.written));
    expect(git(repo, "log", "-1", "--format=%(trailers:only,unfold)")).toBe(
      `Issue: ${a.id}\nIssue-Event: opened\nIssue: ${a.id}\n\n`,
    );
    expect(status(repo)).toBe("");
    verifiesAtHead(repo);
  });

  it("refuses when a description the commit needs is missing, writing nothing", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Other");
    const a = stageNew(repo, "A");
    git(repo, "rm", "-q", "-f", a.body);
    refuses(
      repo,
      ["comment", a.id, "x", "--commit"],
      `${a.opened} has no description; restore it, or run without --commit`,
    );
  });
});
