import { describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";

type Write = {
  ok: boolean;
  issue: { labels: string[]; assignees: string[]; applies_to: string[] } | null;
  written: string[];
  findings: { rule: string }[];
  notes: string[];
};

const EXCLUSIVE = { "docs/issues/issues.toml": '[labels]\nexclusive = ["priority"]\n' };

describe("issues label", () => {
  it("covers every row of the label exclusivity table", async () => {
    await using repo = await cliRepo(EXCLUSIVE);
    newIssue(repo, "One");
    const label = (...args: string[]) => runJson<Write>(repo, ["label", "1", ...args]);
    expect(label("--add", "priority:high").json.issue?.labels).toEqual(["priority:high"]);
    const replaced = label("--add", "priority:low");
    expect(replaced.json.issue?.labels).toEqual(["priority:low"]);
    expect(replaced.json.notes).toContain("replaced priority:high (priority is exclusive)");
    expect(label("--add", "area:a").json.issue?.labels).toEqual(["area:a", "priority:low"]);
    expect(label("--add", "area:b").json.issue?.labels).toEqual([
      "area:a",
      "area:b",
      "priority:low",
    ]);
    const two = label("--add", "priority:high", "--add", "priority:mid");
    expect(two.status).toBe(1);
    expect(two.json.findings.map((f) => f.rule)).toEqual(["issue/label-exclusive"]);
    expect(label("--set", "priority:high", "--set", "priority:mid").status).toBe(1);
    expect(label("--remove", "priority:low").json.issue?.labels).toEqual(["area:a", "area:b"]);
    const absent = label("--remove", "x");
    expect(absent.status).toBe(0);
    expect(absent.json.written).toEqual([]);
    expect(absent.json.notes.some((n) => n.startsWith("x is not a label of ?1"))).toBe(true);
    expect(label("--clear").json.issue?.labels).toEqual([]);
    for (const args of [
      ["--add", "bad label"],
      ["--set", "a", "--add", "b"],
      ["--clear", "--add", "a"],
      [],
    ]) {
      expect(runIssues(repo, ["label", "1", ...args]).status, args.join(" ")).toBe(2);
    }
  });
});

describe("issues assign", () => {
  it("takes me and names, and needs an email for me", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    const r = runJson<Write>(repo, ["assign", "1", "--add", "me", "--add", "bob"]);
    expect(r.status).toBe(0);
    expect(r.json.issue?.assignees).toEqual(["bob", "ledger-test@example.com"]);
    expect(runJson<Write>(repo, ["assign", "1", "--remove", "bob"]).json.issue?.assignees).toEqual([
      "ledger-test@example.com",
    ]);
    const agent = runIssues(repo, ["assign", "1", "--add", "me"], {
      env: { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "a@example.com" },
    });
    expect(agent.status).toBe(0);
    expect(runIssues(repo, ["assign", "1", "--add", "a b"]).status).toBe(2);
  });
});

describe("issues scope", () => {
  it("sets globs and notes the ones that match no tracked file", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    const r = runJson<Write>(repo, ["scope", "1", "--set", "README.md", "--set", "src/**"]);
    expect(r.status).toBe(0);
    expect(r.json.issue?.applies_to).toEqual(["README.md", "src/**"]);
    expect(r.json.notes).toContain("src/** matches no tracked file");
    expect(runIssues(repo, ["scope", "1", "--add", "["]).status).toBe(2);
  });
});
