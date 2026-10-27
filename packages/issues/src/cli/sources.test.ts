import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, newIssue, runIssues, runJson } from "../test-support/cli.js";
import {
  type IssueSourceFixture,
  issueSource,
  networkCommands,
  sourceToml,
} from "../test-support/sources.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
const CONFIG = "docs/issues/issues.toml";
async function consumer(config: string): Promise<{ r: TempRepo; x: string }> {
  const r = await cliRepo({ [CONFIG]: `[log]\nindex = "committed"\n${config}` });
  repos.push(r);
  return { r, x: newIssue(r, "Use the platform API") };
}
async function source(titles?: readonly string[]): Promise<IssueSourceFixture> {
  const s = await issueSource(titles);
  repos.push(s.src, s.bare);
  return s;
}
async function setConfig(r: TempRepo, config: string): Promise<void> {
  await writeFile(join(r.root, CONFIG), `[log]\nindex = "committed"\n${config}`);
}
async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}
type Found = { rule: string; message: string; subject: string | null };
type Status = { name: string; kind: string; ref: string; commit: string | null; fetched: boolean };
const verifyJson = (r: TempRepo, args: string[] = []) => {
  const out = runJson<{ findings: Found[]; sources?: Status[] }>(r, ["verify", ...args]);
  return { ...out, found: out.json.findings ?? [], sources: out.json.sources };
};

describe("issues' cross-repository references", { timeout: 120_000 }, () => {
  it("warns once per uncached source without touching the network", async () => {
    const s = await source(["One", "Two"]);
    const { r, x } = await consumer(sourceToml("platform", s.url));
    for (const id of s.issues) {
      const out = runIssues(r, ["link", x, `platform:${id}`, "--commit"]);
      expect(out.status, out.stderr).toBe(0);
      expect(out.stderr).toContain("platform not fetched; the reference isn't checked");
    }
    const trace = join(r.root, "..", "trace.json");
    const out = runJson<{ findings: Found[]; sources: Status[] }>(r, ["verify"], {
      env: { GIT_TRACE2_EVENT: trace },
    });
    expect(out.status).toBe(0);
    expect(out.json.findings.map((f) => [f.rule, f.message])).toEqual([
      [
        "sources/not-fetched",
        "platform not fetched; references not checked. Run issues sources fetch, or verify with --fetch-sources",
      ],
    ]);
    expect(out.json.sources).toEqual([
      { name: "platform", kind: "issues", ref: "main", commit: null, fetched: false },
    ]);
    expect(await networkCommands(trace)).toEqual([]);
  });

  it("checks references against the cache, and fetches with --fetch-sources", async () => {
    const s = await source();
    const { r, x } = await consumer(sourceToml("platform", s.url));
    expect(runIssues(r, ["link", x, "platform:zzzzzzzz", "--commit"]).status).toBe(0);
    const head = (await s.src.git.resolveCommit("HEAD")) ?? "";
    expect(runIssues(r, ["sources", "fetch"]).stdout).toBe(
      `fetched platform (main) at ${head.slice(0, 12)}\n`,
    );
    const cached = verifyJson(r);
    expect(cached.status).toBe(1);
    expect(cached.found.map((f) => [f.rule, f.message])).toEqual([
      ["issue/reference-missing", "relates-to platform:zzzzzzzz, which is not in source platform"],
    ]);
    expect(cached.sources).toEqual([
      { name: "platform", kind: "issues", ref: "main", commit: head, fetched: false },
    ]);
    // A link to a missing id in a cached source is refused, and nothing is written.
    const status = await git(r, "status", "--porcelain");
    const refused = runIssues(r, ["link", x, "platform:yyyyyyyy"]);
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("issue/reference-missing");
    expect(await git(r, "status", "--porcelain")).toBe(status);
    // --fetch-sources moves the pin; a failed fetch exits 2 and plain verify still reads the cache.
    expect(runIssues(r, ["unlink", x, "platform:zzzzzzzz", "--commit"]).status).toBe(0);
    await s.add("Three");
    const next = await s.src.git.resolveCommit("HEAD");
    const fetched = verifyJson(r, ["--fetch-sources"]);
    expect(fetched.status).toBe(0);
    expect(fetched.sources?.[0]).toMatchObject({ commit: next, fetched: true });
    await rename(s.url, `${s.url}.moved`);
    const failed = runIssues(r, ["verify", "--fetch-sources"]);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toMatch(
      /^issues: error: cannot fetch source platform \(main\): .+; the cache still pins /,
    );
    expect(runIssues(r, ["verify"]).status).toBe(0);
    await rename(`${s.url}.moved`, s.url);
  });

  it("pins branch, full ref, annotated tag and full sha refs", async () => {
    const s = await source();
    const tagged = (await s.src.git.resolveCommit("v1^{commit}")) ?? "";
    await s.add("Later");
    const tip = (await s.src.git.resolveCommit("HEAD")) ?? "";
    const { r } = await consumer("");
    for (const [ref, want] of [
      ["main", tip],
      ["refs/heads/main", tip],
      ["v1", tagged],
      [tagged, tagged],
    ] as const) {
      await setConfig(r, sourceToml("platform", s.url, { ref }));
      const out = verifyJson(r, ["--fetch-sources"]);
      expect([ref, out.status, out.sources?.[0]?.commit]).toEqual([ref, 0, want]);
    }
  });

  it("warns on a foreign decision that isn't accepted, and blocks on a foreign open issue", async () => {
    const s = await source();
    const { r, x } = await consumer(
      sourceToml("platform", s.url) + sourceToml("platform-adr", s.url, { kind: "adr" }),
    );
    expect(runIssues(r, ["sources", "fetch"]).status).toBe(0);
    expect(
      runIssues(r, ["link", x, `platform-adr:${s.decision}`, "--rel", "implements", "--commit"])
        .status,
    ).toBe(0);
    expect(verifyJson(r).found.map((f) => f.rule)).toEqual(["issue/implements-unaccepted"]);
    const index = await readFile(join(r.root, "docs/issues/index.md"), "utf8");
    const dep = `platform:${s.issues[0]}`;
    expect(runIssues(r, ["link", x, dep, "--rel", "depends-on", "--commit"]).status).toBe(0);
    const listed = runJson<{ issues: { id: string; blocked_by_open: string[]; ready: boolean }[] }>(
      r,
      ["list"],
    );
    expect(listed.json.issues.find((i) => i.id === x)).toMatchObject({
      blocked_by_open: [dep],
      ready: false,
    });
    // The index reads no sources: it doesn't change with the cache.
    const after = await readFile(join(r.root, "docs/issues/index.md"), "utf8");
    expect(runIssues(r, ["sources", "fetch"]).status).toBe(0);
    expect(await readFile(join(r.root, "docs/issues/index.md"), "utf8")).toBe(after);
    // The issue is blocked only in another repository, so the index still lists it as Ready.
    expect(after).toBe(index);
    expect(runIssues(r, ["index", "--check"]).status).toBe(0);
  });

  it("lists a cached source's issues with its numbers", async () => {
    const s = await source(["Provide the platform API", "Document it"]);
    const { r } = await consumer(sourceToml("platform", s.url));
    const before = runJson<{ source: string; issues: unknown[] }>(r, [
      "list",
      "--source",
      "platform",
    ]);
    expect(before.json).toMatchObject({ source: "platform", issues: [] });
    expect(before.stderr).toContain("platform not fetched; run issues sources fetch");
    expect(runIssues(r, ["sources", "fetch", "platform"]).status).toBe(0);
    const listed = runJson<{ issues: { id: string; display: string }[] }>(r, [
      "list",
      "--source",
      "platform",
    ]);
    expect(listed.json.issues.map((i) => [i.id, i.display])).toEqual([
      [s.issues[0], "?1"],
      [s.issues[1], "?2"],
    ]);
    expect(runIssues(r, ["list", "--source", "nope"]).status).toBe(2);
  });

  it("refuses a source kind it doesn't know", async () => {
    const r = await cliRepo({ [CONFIG]: sourceToml("x", "../x.git", { kind: "foo" }) });
    repos.push(r);
    const out = runIssues(r, ["list"]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('sources[0].kind must be "issues" or "adr"');
  });
});
