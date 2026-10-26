import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliRepo, runIssues, runJson, TASK_FLAGS, WRITE_KEYS } from "../test-support/cli.js";

type Write = {
  ok: boolean;
  command: string;
  issue: {
    id: string;
    display: string;
    parent: string | null;
    depends_on: string[];
    labels: string[];
    body_path: string;
  } | null;
  written: string[];
  commit: string | null;
  findings: { rule: string }[];
  notes: string[];
};

describe("issues new", () => {
  it("opens an issue with a parent, dependencies and labels, and commits it", async () => {
    await using repo = await cliRepo();
    const one = runJson<Write>(repo, ["new", "Parent", ...TASK_FLAGS, "--commit"]);
    expect(one.status).toBe(0);
    expect(Object.keys(one.json).sort()).toEqual(WRITE_KEYS);
    expect(one.json).toMatchObject({ ok: true, command: "new", issue: { display: "?1" } });
    runJson<Write>(repo, ["new", "Dep", ...TASK_FLAGS, "--commit"]);
    const r = runJson<Write>(repo, [
      "new",
      "Child",
      ...TASK_FLAGS,
      "--parent",
      "1",
      "--depends-on",
      "2",
      "--depends-on",
      "?2",
      "--label",
      "type:bug",
      "--commit",
    ]);
    expect(r.status).toBe(0);
    expect(r.json.issue).toMatchObject({
      display: "?3",
      parent: one.json.issue?.id,
      labels: ["type:bug"],
    });
    expect(r.json.issue?.depends_on).toHaveLength(1);
  });

  it("refuses exclusive labels (exit 1) and bad input (exit 2)", async () => {
    await using repo = await cliRepo({
      "docs/issues/issues.toml": '[labels]\nexclusive = ["type"]\n',
    });
    const r = runJson<Write>(repo, [
      "new",
      "x",
      ...TASK_FLAGS,
      "--label",
      "type:bug",
      "--label",
      "type:feature",
    ]);
    expect(r.status).toBe(1);
    expect(r.json.findings.map((f) => f.rule)).toEqual(["issue/label-exclusive"]);
    expect(r.json.written).toEqual([]);
    const many = Array.from({ length: 51 }, () => ["--depends-on", "1"]).flat();
    for (const args of [
      ["new", " "],
      ["new", "x", "--section", "nope"],
      ["new", "x", "--section", "goal=a", "--section", "goal=b"],
      ["new", "x", "--section", "nope=a"],
      ["new", "x", "--parent", "9"],
      ["new", "x", "--template", "nope"],
      ["new", "x", ...many],
    ]) {
      expect(runIssues(repo, args).status, args.join(" ")).toBe(2);
    }
  });

  it("never commits an incomplete draft", async () => {
    await using repo = await cliRepo();
    const refused = runJson<Write>(repo, ["new", "Draft", "--commit"]);
    expect(refused.status).toBe(1);
    expect(refused.json.written).toEqual([]);
    const staged = runJson<Write>(repo, ["new", "Draft"]);
    expect(staged.status).toBe(0);
    expect(staged.json.commit).toBeNull();
    expect(staged.stderr).toContain("template/guidance-left");
    expect(runIssues(repo, ["verify"]).status).toBe(1);
  });

  it("runs the editor with --edit, and leaves an unfilled draft staged", async () => {
    await using repo = await cliRepo();
    const filler = join(repo.root, "..", "fill.sh");
    await writeFile(
      filler,
      '#!/bin/sh\nprintf "# Edited\\n\\n## Goal\\nA goal.\\n\\n## Notes\\n\\n## Done when\\nDone.\\n" > "$1"\n',
    );
    await chmod(filler, 0o755);
    const r = runJson<Write>(repo, ["new", "Edit me", "--edit", "--commit"], {
      env: { EDITOR: filler },
    });
    expect(r.status).toBe(0);
    expect(r.json.commit).not.toBeNull();
    expect(await readFile(join(repo.root, r.json.issue?.body_path ?? ""), "utf8")).toContain(
      "A goal.",
    );
    const noop = join(repo.root, "..", "noop.sh");
    await writeFile(noop, "#!/bin/sh\nexit 0\n");
    await chmod(noop, 0o755);
    const draft = runJson<Write>(repo, ["new", "Still a draft", "--edit", "--commit"], {
      env: { EDITOR: noop },
    });
    expect(draft.status).toBe(0);
    expect(draft.json.commit).toBeNull();
    expect(draft.stderr).toContain("still has unfilled required sections");
    const noEditor = runJson<Write>(repo, ["new", "x", ...TASK_FLAGS, "--edit"]);
    expect(noEditor.stderr).toContain("no editor: set VISUAL or EDITOR");
  });
});
