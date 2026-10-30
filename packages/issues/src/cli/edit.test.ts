import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { cliEnv, cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

const git = (repo: TempRepo, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo.root, env: cliEnv(repo), encoding: "utf8" });

type Write = {
  ok: boolean;
  issue: { title: string; body_path: string } | null;
  written: string[];
  commit: string | null;
  notes: string[];
};

describe("issues edit", () => {
  it("replaces the title and sections without an editor", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Old title");
    const r = runJson<Write>(repo, [
      "edit",
      "1",
      "--title",
      "New title",
      "--section",
      "goal=A new goal.",
      "--commit",
    ]);
    expect(r.status).toBe(0);
    expect(r.json.issue?.title).toBe("New title");
    const body = await readFile(join(repo.root, r.json.issue?.body_path ?? ""), "utf8");
    expect(body.startsWith("# New title\n")).toBe(true);
    expect(body).toContain("## Goal\nA new goal.\n");
    expect(r.json.commit).not.toBeNull();
    const same = runJson<Write>(repo, ["edit", "1", "--title", "New title"]);
    expect(same.status).toBe(0);
    expect(same.json.notes).toContain("nothing changed");
    expect(runIssues(repo, ["edit", "1", "--section", "nope=x"]).status).toBe(2);
  });

  it("removes an empty optional section and puts it back in template order", async () => {
    await using repo = await cliRepo();
    const id = newIssue(repo, "T", ["--section", "notes=N"]);
    const path = join(repo.root, `docs/issues/items/${id}-t.md`);
    const removed = runJson<Write>(repo, ["edit", "1", "--section", "notes="]);
    expect(removed.status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(
      "# T\n\n## Goal\nDo the thing.\n\n## Done when\nThe thing is done.\n",
    );
    const again = runJson<Write>(repo, ["edit", "1", "--section", "notes="]);
    expect(again.status).toBe(0);
    expect(again.json.notes).toContain("nothing changed");
    const back = runJson<Write>(repo, ["edit", "1", "--section", "notes=Back"]);
    expect(back.status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(
      "# T\n\n## Goal\nDo the thing.\n\n## Notes\nBack\n\n## Done when\nThe thing is done.\n",
    );
  });

  it("refuses to commit an empty required section", async () => {
    await using repo = await cliRepo();
    const id = newIssue(repo, "T", ["--section", "notes=N"]);
    const path = join(repo.root, `docs/issues/items/${id}-t.md`);
    const head = git(repo, "rev-parse", "HEAD");
    const before = await readFile(path);
    const r = runIssues(repo, ["edit", "1", "--section", "done=", "--commit"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not edited");
    expect(r.stdout).toContain("[template/section-empty]");
    expect(await readFile(path)).toEqual(before);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    const doc = runJson<Write>(repo, ["edit", "1", "--section", "done=", "--commit"]);
    expect(doc.json.ok).toBe(false);
    expect(doc.json.written).toEqual([]);
  });

  it("keeps an empty required section with a warning when it only stages", async () => {
    await using repo = await cliRepo();
    const id = newIssue(repo, "T", ["--section", "notes=N"]);
    const path = join(repo.root, `docs/issues/items/${id}-t.md`);
    const r = runIssues(repo, ["edit", "1", "--section", "done=", "--no-commit"]);
    expect(r.status).toBe(0);
    expect((await readFile(path, "utf8")).endsWith("## Done when\n")).toBe(true);
    expect(r.stderr).toContain("warning: template/section-empty");
  });

  it("adds a heading when the body has none", async () => {
    await using repo = await cliRepo();
    const id = newIssue(repo, "Headless");
    const path = join(repo.root, `docs/issues/items/${id}-headless.md`);
    await writeFile(path, "no heading here\n");
    const r = runJson<Write>(repo, ["edit", id, "--title", "Has one"]);
    expect(r.status).toBe(0);
    expect(await readFile(path, "utf8")).toBe("# Has one\n\nno heading here\n");
  });

  it("runs the editor, and needs one without --title or --section", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "Edit me");
    expect(runIssues(repo, ["edit", "1"]).status).toBe(2);
    expect(runIssues(repo, ["edit", "1"]).stderr).toContain("no editor: set VISUAL or EDITOR");
    const append = join(repo.root, "..", "append.sh");
    await writeFile(append, '#!/bin/sh\nprintf "\\nMore context.\\n" >> "$1"\n');
    await chmod(append, 0o755);
    const r = runJson<Write>(repo, ["edit", "1", "--commit"], { env: { EDITOR: append } });
    expect(r.status).toBe(0);
    expect(r.json.written).toHaveLength(1);
    expect(r.json.commit).not.toBeNull();
    const noop = join(repo.root, "..", "noop.sh");
    await writeFile(noop, "#!/bin/sh\nexit 0\n");
    await chmod(noop, 0o755);
    expect(runJson<Write>(repo, ["edit", "1"], { env: { EDITOR: noop } }).json.notes).toContain(
      "nothing changed",
    );
    expect(runIssues(repo, ["edit", "1", "--no-edit"]).status).toBe(2);
  });
});
