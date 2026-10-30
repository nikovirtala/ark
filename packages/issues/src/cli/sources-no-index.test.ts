import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, runIssues, runJson } from "../test-support/cli.js";
import { issueSource, sourceToml } from "../test-support/sources.js";

const NOTE =
  "issue numbers are unavailable (platform has no committed index.md); issues display by id";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

describe("a cached source without a committed index.md", () => {
  it("lists and searches its issues by id, with a note naming the missing index", async () => {
    const s = await issueSource(["Provide the platform API", "Document the API"], {
      index: "none",
    });
    repos.push(s.src, s.bare);
    const repo = await cliRepo({ "docs/issues/issues.toml": sourceToml("platform", s.url) });
    repos.push(repo);
    expect(runIssues(repo, ["sources", "fetch", "platform"]).status).toBe(0);

    const list = runJson<{
      numbering: { available: boolean; reason: string | null };
      issues: { id: string; display: string }[];
    }>(repo, ["list", "--source", "platform"]);
    expect(list.status).toBe(0);
    expect(list.json.numbering).toMatchObject({ available: false, reason: "no-index" });
    expect(list.json.issues.map((i) => i.display).sort()).toEqual([...s.issues].sort());
    expect(list.stderr).toContain(NOTE);
    expect(list.stderr).not.toContain("no main branch");

    const search = runIssues(repo, ["search", "api", "--source", "platform"]);
    expect(search.status).toBe(0);
    expect(search.stderr).toContain(NOTE);
    expect(search.stderr).not.toContain("no main branch");
  });
});
