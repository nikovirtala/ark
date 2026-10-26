import { UsageError } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { openIssueLog, readIssues } from "./log.js";
import { issuesFor } from "./scope.js";
import { IDS, issueEvent, issueFiles, opened } from "./test-support/events.js";

const { A, B, C, Z } = IDS;

async function repoWith(): Promise<TempRepo> {
  const repo = await createTempRepo({
    files: {
      ...issueFiles([
        {
          id: A,
          events: [opened(A, "Auth"), issueEvent(A, "scoped", { data: { set: ["src/auth/**"] } })],
        },
        {
          id: B,
          events: [
            opened(B, "Closed auth"),
            issueEvent(B, "scoped", { data: { set: ["src/auth/**"] } }),
            issueEvent(B, "closed", { data: { resolution: "done" } }),
          ],
        },
        { id: C, events: [opened(C, "Anchored"), issueEvent(C, "started")] },
      ]),
      "src/auth/session.ts": `// issue:${C}\n// issue:${B}\nexport {};\n// issue:${Z}\n// issue:platform:${A}\n`,
      "src/other.ts": "export {};\n",
      "src/dir/a.ts": "x\n",
    },
  });
  return repo;
}

async function forPaths(repo: TempRepo, paths: string[], o: { all?: boolean; cwd?: string } = {}) {
  const log = await openIssueLog({ cwd: repo.root, gitOptions: { env: repo.env } });
  return issuesFor(await readIssues(log), log, { paths, ...o });
}

describe("issuesFor", () => {
  it("lists open issues by glob and anchor, and unresolved anchors", async () => {
    await using repo = await repoWith();
    const doc = await forPaths(repo, ["src/auth/session.ts"]);
    expect(doc.format).toBe("issues-for/v1");
    const [p] = doc.paths;
    expect(p?.tracked).toBe(true);
    expect(p?.issues.map((i) => [i.id, i.state, i.via])).toEqual([
      [C, "in-progress", [{ type: "anchor", line: 1 }]],
      [A, "open", [{ type: "glob", glob: "src/auth/**" }]],
    ]);
    expect(p?.unresolved).toEqual([
      { ref: Z, line: 4, reason: "not-found" },
      { ref: `platform:${A}`, line: 5, reason: "other-log" },
    ]);
  });

  it("includes closed issues named by anchors with --all, never by globs", async () => {
    await using repo = await repoWith();
    const doc = await forPaths(repo, ["src/auth/session.ts"], { all: true });
    expect(doc.paths[0]?.issues.map((i) => [i.id, i.via])).toEqual([
      [C, [{ type: "anchor", line: 1 }]],
      [A, [{ type: "glob", glob: "src/auth/**" }]],
      [B, [{ type: "anchor", line: 2 }]],
    ]);
    expect(doc.paths[0]?.issues[2]?.warning).toMatch(/^CLOSED on /);
  });

  it("takes untracked paths and paths relative to cwd", async () => {
    await using repo = await repoWith();
    await repo.write("src/auth/new.ts", "x\n");
    const doc = await forPaths(repo, ["new.ts", "../other.ts"], { cwd: `${repo.root}/src/auth` });
    expect(doc.paths.map((p) => [p.path, p.tracked, p.issues.map((i) => i.id)])).toEqual([
      ["src/auth/new.ts", false, [A]],
      ["src/other.ts", true, []],
    ]);
  });

  it("refuses directories, paths outside the repository and the wrong number of paths", async () => {
    await using repo = await repoWith();
    for (const [paths, message] of [
      [["src/dir"], "src/dir is a directory"],
      [["../outside.ts"], "is outside the repository"],
      [[], "issues for takes 1 to 100 paths"],
      [Array.from({ length: 101 }, (_, i) => `f${i}.ts`), "issues for takes 1 to 100 paths"],
      [["x".repeat(4097)], "a path can be at most 4096 characters"],
    ] as const) {
      const err = await forPaths(repo, [...paths]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain(message);
    }
  });
});
