import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

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

  it("removes an optional section with empty text and adds it back in the template's order", async () => {
    await using repo = await cliRepo();
    const r = runJson<Write>(repo, [
      "new",
      "Sections",
      "--section",
      "goal=G.",
      "--section",
      "notes=N.",
      "--section",
      "done=D.",
      "--commit",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const path = join(repo.root, r.json.issue?.body_path ?? "");
    const full = "# Sections\n\n## Goal\nG.\n\n## Notes\nN.\n\n## Done when\nD.\n";
    expect(await readFile(path, "utf8")).toBe(full);
    expect(runIssues(repo, ["edit", "1", "--section", "notes=", "--commit"]).status).toBe(0);
    expect(await readFile(path, "utf8")).toBe("# Sections\n\n## Goal\nG.\n\n## Done when\nD.\n");
    const again = runJson<Write>(repo, ["edit", "1", "--section", "notes="]);
    expect(again.json.notes).toContain("nothing changed");
    expect(runIssues(repo, ["edit", "1", "--section", "notes=N.", "--commit"]).status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(full);
    expect(runIssues(repo, ["verify"]).status).toBe(0);
  });

  it("removes the last section when it is optional, and keeps an empty required one", async () => {
    await using repo = await cliRepo();
    expect(runIssues(repo, ["init", "--template", "feature", "--commit"]).status).toBe(0);
    const r = runJson<Write>(repo, [
      "new",
      "Feature",
      "--template",
      "feature",
      "--section",
      "problem=P.",
      "--section",
      "proposal=Q.",
      "--section",
      "done=D.",
      "--commit",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const path = join(repo.root, r.json.issue?.body_path ?? "");
    const body = await readFile(path, "utf8");
    // A hand-edited body whose optional section comes last.
    await writeFile(path, `${body}\n## Alternatives\nA.\n`);
    expect(runIssues(repo, ["edit", "1", "--section", "alternatives="]).status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(body);
    // An empty required section keeps its heading, and lint reports it.
    const emptied = runJson<Write & { findings: { rule: string }[] }>(repo, [
      "edit",
      "1",
      "--section",
      "done=",
    ]);
    expect(emptied.status).toBe(0);
    expect(emptied.json.findings.map((f) => f.rule)).toEqual(["template/section-empty"]);
    expect(await readFile(path, "utf8")).toBe(body.replace("## Done when\nD.\n", "## Done when\n"));
    expect(runIssues(repo, ["verify"]).status).toBe(1);
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
