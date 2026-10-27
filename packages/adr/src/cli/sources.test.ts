import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { serveAdrMcp } from "../mcp/server.js";
import { cliRepo, runAdr, seedDecision } from "../test-support/cli.js";
import {
  type DecisionSourceFixture,
  decisionSource,
  networkCommands,
  sourceToml,
} from "../test-support/sources.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});

/** A consumer repository with a decision of its own and `config` as docs/adr/adr.toml. */
async function consumer(config: string): Promise<{ r: TempRepo; a: string }> {
  const r = await cliRepo({ "docs/adr/adr.toml": config });
  repos.push(r);
  return { r, a: await seedDecision(r, "Use the platform's queue") };
}

async function source(titles?: readonly string[]): Promise<DecisionSourceFixture> {
  const s = await decisionSource(titles);
  repos.push(s.src, s.bare);
  return s;
}

const json = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;
const rules = (stdout: string) =>
  (json(stdout).findings as { rule: string; message: string }[]).map((f) => [f.rule, f.message]);

async function setConfig(r: TempRepo, text: string): Promise<void> {
  await writeFile(join(r.root, "docs/adr/adr.toml"), text);
}

describe("adr's cross-repository references", { timeout: 120_000 }, () => {
  it("warns once per uncached source and never touches the network without --fetch-sources", async () => {
    const s = await source(["Use Aurora", "Use Kafka"]);
    const { r, a } = await consumer(sourceToml("platform", s.url));
    for (const id of s.ids) {
      const out = runAdr(r, ["link", a, `platform:${id}`, "--commit"]);
      expect(out.status).toBe(0);
      expect(out.stderr).toContain("platform not fetched; the reference isn't checked");
    }
    const trace = join(r.root, "..", "trace.json");
    const out = runAdr(r, ["verify", "--json"], { env: { GIT_TRACE2_EVENT: trace } });
    expect(out.status).toBe(0);
    expect(rules(out.stdout)).toEqual([
      [
        "sources/not-fetched",
        "platform not fetched; references not checked. Run adr sources fetch, or verify with --fetch-sources",
      ],
    ]);
    expect(json(out.stdout).sources).toEqual([
      { name: "platform", kind: "adr", ref: "main", commit: null, fetched: false },
    ]);
    expect(await networkCommands(trace)).toEqual([]);
  });

  it("checks references against the cache after sources fetch", async () => {
    const s = await source();
    const { r, a } = await consumer(sourceToml("platform", s.url));
    expect(runAdr(r, ["link", a, "platform:zzzzzzzz", "--commit"]).status).toBe(0);
    const head = (await s.src.git.resolveCommit("HEAD")) ?? "";
    const fetched = runAdr(r, ["sources", "fetch"]);
    expect(fetched).toMatchObject({
      status: 0,
      stdout: `fetched platform (main) at ${head.slice(0, 12)}\n`,
    });
    const out = runAdr(r, ["verify", "--json"]);
    expect(out.status).toBe(1);
    expect(rules(out.stdout)).toEqual([
      [
        "decision/reference-missing",
        `links to platform:zzzzzzzz, which is not in source platform at ${head.slice(0, 12)}`,
      ],
    ]);
    expect(json(out.stdout).sources).toEqual([
      { name: "platform", kind: "adr", ref: "main", commit: head, fetched: false },
    ]);
    // A cached source refuses a link to a missing id and writes nothing.
    const refused = runAdr(r, ["link", a, "platform:yyyyyyyy"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe(
      `adr: error: platform:yyyyyyyy is not in source platform (pinned at ${head.slice(0, 12)})\n`,
    );
    // An existing id passes.
    const b = await seedDecision(r, "Use the platform's cache");
    expect(runAdr(r, ["link", b, `platform:${s.ids[0]}`, "--commit"]).status).toBe(0);
    const text = runAdr(r, ["verify"]);
    expect(text.stdout.match(/reference-missing/g)).toHaveLength(1);
    expect(text.stderr).toContain(
      `adr: warning: source platform (main) at ${head.slice(0, 12)}, from the cache\n`,
    );
  });

  it("fetches with --fetch-sources, moves the pin, and exits 2 when the fetch fails", async () => {
    const s = await source();
    const { r, a } = await consumer(sourceToml("platform", s.url));
    expect(runAdr(r, ["link", a, `platform:${s.ids[0]}`, "--commit"]).status).toBe(0);
    const first = runAdr(r, ["verify", "--fetch-sources", "--json"]);
    expect(first.status).toBe(0);
    const head1 = await s.src.git.resolveCommit("HEAD");
    expect(json(first.stdout).sources).toEqual([
      { name: "platform", kind: "adr", ref: "main", commit: head1, fetched: true },
    ]);
    await s.add("Use Redis");
    const head2 = await s.src.git.resolveCommit("HEAD");
    const second = runAdr(r, ["verify", "--fetch-sources", "--json"]);
    expect((json(second.stdout).sources as { commit: string }[])[0]?.commit).toBe(head2);
    await rename(s.url, `${s.url}.moved`);
    const failed = runAdr(r, ["verify", "--fetch-sources"]);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toMatch(
      new RegExp(
        `^adr: error: cannot fetch source platform \\(main\\): .+; the cache still pins ${head2?.slice(0, 12)}\\n$`,
      ),
    );
    const json2 = runAdr(r, ["--json", "verify", "--fetch-sources"]);
    expect(json2.status).toBe(2);
    expect(json(json2.stdout)).toMatchObject({ format: "ark-error/v1" });
    expect(runAdr(r, ["verify"]).status).toBe(0);
    await rename(`${s.url}.moved`, s.url);
  });

  it("pins branch, full ref, annotated tag and full sha refs", async () => {
    const s = await source();
    const tagged = (await s.src.git.resolveCommit("v1^{commit}")) ?? "";
    await s.add("Use Redis");
    const tip = (await s.src.git.resolveCommit("HEAD")) ?? "";
    const { r } = await consumer("");
    for (const [ref, want] of [
      ["main", tip],
      ["refs/heads/main", tip],
      ["v1", tagged],
      [tagged, tagged],
    ] as const) {
      await setConfig(r, sourceToml("platform", s.url, { ref }));
      const out = runAdr(r, ["verify", "--fetch-sources", "--json"]);
      expect([ref, out.status]).toEqual([ref, 0]);
      expect([ref, (json(out.stdout).sources as { commit: string }[])[0]?.commit]).toEqual([
        ref,
        want,
      ]);
    }
  });

  it("reports a qualified reference whose source isn't configured", async () => {
    const s = await source();
    const { r, a } = await consumer(sourceToml("platform", s.url));
    expect(runAdr(r, ["link", a, `platform:${s.ids[0]}`, "--commit"]).status).toBe(0);
    await setConfig(r, "");
    const out = runAdr(r, ["verify", "--json"]);
    expect(out.status).toBe(1);
    expect(rules(out.stdout)).toEqual([
      [
        "decision/unknown-source",
        `links to platform:${s.ids[0]}, whose source platform isn't in [[sources]]`,
      ],
    ]);
  });

  it("lists and searches a cached source with --source, also through MCP", async () => {
    const s = await source(["Use Aurora for orders"]);
    const { r } = await consumer(sourceToml("platform", s.url));
    const before = runAdr(r, ["list", "--source", "platform", "--json"]);
    expect(before.status).toBe(0);
    expect(json(before.stdout)).toMatchObject({ source: "platform", decisions: [] });
    expect(before.stderr).toContain("platform not fetched; run adr sources fetch");
    expect(runAdr(r, ["sources", "fetch", "platform"]).status).toBe(0);
    const list = runAdr(r, ["list", "--source", "platform", "--json"]);
    const decisions = json(list.stdout).decisions as { id: string; display: string }[];
    expect(decisions.map((d) => [d.id, d.display])).toEqual([[s.ids[0], "ADR-0001"]]);
    const local = runAdr(r, ["list"]);
    expect(local.stdout).toContain("Use the platform's queue");
    expect(local.stderr).toContain(
      "the logs in [[sources]] (platform) are listed with --source <name>, from cached copies; run adr sources fetch to update them",
    );
    const search = runAdr(r, ["search", "aurora", "--source", "platform", "--json"]);
    expect(json(search.stdout)).toMatchObject({ source: "platform", total: 1 });
    expect(runAdr(r, ["list", "--source", "nope"]).status).toBe(2);
    expect(runAdr(r, ["list", "--source", "platform", "--since", "HEAD"]).status).toBe(2);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const served = serveAdrMcp({
      cwd: r.root,
      root: null,
      env: { ...r.env, ARK_ON_BEHALF_OF: "ada@example.com" },
      version: "0.0.0-test",
      stderr: { write: () => {} },
      transport: serverSide,
    });
    const client = new Client({ name: "sources-test", version: "1" });
    await client.connect(clientSide);
    const res = (await client.callTool({
      name: "adr_list",
      arguments: { source: "platform" },
    })) as unknown as {
      structuredContent: { source: string; decisions: { id: string }[] };
    };
    expect(res.structuredContent.source).toBe("platform");
    expect(res.structuredContent.decisions.map((d) => d.id)).toEqual([s.ids[0]]);
    const found = (await client.callTool({
      name: "adr_search",
      arguments: { query: "aurora", source: "platform" },
    })) as unknown as { structuredContent: { total: number } };
    expect(found.structuredContent.total).toBe(1);
    await client.close();
    await served;
  });

  it("never fetches sources of kinds adr doesn't read", async () => {
    const s = await source();
    const { r } = await consumer(
      sourceToml("platform", s.url) +
        sourceToml("tracker", "/nowhere/tracker.git", { kind: "issues" }),
    );
    const out = runAdr(r, ["verify", "--fetch-sources", "--json"]);
    expect(out.status).toBe(0);
    expect((json(out.stdout).sources as { name: string }[]).map((x) => x.name)).toEqual([
      "platform",
    ]);
    const fetched = runAdr(r, ["sources", "fetch"]);
    expect(fetched.status).toBe(0);
    expect(fetched.stdout).toContain("skipped tracker (kind issues isn't read by adr)\n");
    const named = runAdr(r, ["sources", "fetch", "tracker"]);
    expect(named.status).toBe(2);
    expect(named.stderr).toBe(
      "adr: error: source tracker has kind issues, which adr doesn't read\n",
    );
    expect(await readFile(join(r.root, "docs/adr/adr.toml"), "utf8")).toContain("tracker");
  });
});
