import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openIssueLog, readIssues, readSourceIssues, resolveIssue } from "../log.js";
import { issuesFor } from "../scope.js";
import { searchIssues } from "../search.js";
import { listTemplates } from "../templates/list.js";
import { cliRepo, newIssue, runIssues } from "../test-support/cli.js";
import { connectMcp, type McpIssues, ME, mcpRepo, structured, text } from "../test-support/mcp.js";
import { issueSource, networkCommands, sourceToml } from "../test-support/sources.js";
import { listIssues, readyIssues, showIssue } from "../views.js";

const repos: TempRepo[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closes.splice(0)) await c();
  for (const r of repos.splice(0)) await r.dispose();
});

async function setup(files: Record<string, string> = {}): Promise<{ r: TempRepo; ids: McpIssues }> {
  const s = await mcpRepo(files);
  repos.push(s.r);
  return s;
}
async function connect(r: TempRepo, env?: NodeJS.ProcessEnv) {
  const c = await connectMcp(r, env);
  closes.push(c.close);
  return c.client;
}

const json = (x: unknown) => JSON.parse(JSON.stringify(x));
const read = async (r: TempRepo, ref: string | null = null) =>
  readIssues(await openIssueLog({ cwd: r.root, ref, gitOptions: { env: r.env } }));

describe("issues mcp read tools", { timeout: 60_000 }, () => {
  it("lists the read tools first, and every schema refuses a wrong type and an extra property", async () => {
    const r = await cliRepo();
    repos.push(r);
    const client = await connect(r);
    const tools = (await client.listTools()).tools.slice(0, 6);
    expect(tools.map((t) => t.name)).toEqual([
      "issues_search",
      "issues_get",
      "issues_list",
      "issues_ready",
      "issues_for_path",
      "issues_templates",
    ]);
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const extra = await client.callTool({ name: t.name, arguments: { nope: 1 } });
      expect(extra.isError, t.name).toBe(true);
      expect(structured(extra), t.name).toMatchObject({
        format: "ark-error/v1",
        error: { code: "usage" },
      });
      const props = Object.keys((t.inputSchema.properties ?? {}) as object);
      const [first] = props;
      if (first === undefined) continue;
      const wrong = await client.callTool({ name: t.name, arguments: { [first]: { x: 1 } } });
      expect(wrong.isError, t.name).toBe(true);
      expect(structured(wrong), t.name).toMatchObject({
        error: { code: "usage", message: expect.stringMatching(/^invalid input for /) },
      });
    }
  });

  it("issues_search returns searchIssues' document, headers in its text", async () => {
    const { r, ids } = await setup();
    const client = await connect(r);
    const now = await read(r);

    const open = await client.callTool({ name: "issues_search", arguments: { query: "safari" } });
    expect(structured(open)).toEqual(
      json(searchIssues(now, { query: "safari", includeClosed: false, limit: 10 })),
    );
    expect(text(open).split("\n")).toEqual([
      `?1 (${ids.a}) · in-progress`,
      "  Login fails on Safari",
      "  (title match)",
      "1 of 1 shown",
      "2 closed issues also match; pass include_closed",
    ]);

    const heading = text(
      await client.callTool({ name: "issues_search", arguments: { query: "when" } }),
    );
    expect(heading).toContain(`?5 (${ids.e}) · open\n  Add dark mode\n  ## Done when\n`);
    expect(heading).not.toContain("( match)");

    const all = await client.callTool({
      name: "issues_search",
      arguments: { query: "safari", include_closed: true },
    });
    expect(structured(all)).toEqual(
      json(searchIssues(now, { query: "safari", includeClosed: true, limit: 10 })),
    );
    const t = text(all);
    expect(t).toContain(
      `?2 (${ids.b}) · closed\nDUPLICATE of ?1 (in-progress). Track work on ?1; read issues://issue/1.\n  Safari login loops`,
    );
    expect(t.split("\n").at(-1)).toBe("3 of 3 shown");
    const one = await client.callTool({
      name: "issues_search",
      arguments: { query: "safari", include_closed: true, limit: 1 },
    });
    expect(structured(one)).toEqual(
      json(searchIssues(now, { query: "safari", includeClosed: true, limit: 1 })),
    );
    expect(text(one).split("\n").at(-1)).toBe("1 of 3 shown");

    const none = await client.callTool({ name: "issues_search", arguments: { query: "zzz" } });
    expect(text(none)).toBe("No open issues match.");
    const noneAll = await client.callTool({
      name: "issues_search",
      arguments: { query: "zzz", include_closed: true },
    });
    expect(text(noneAll)).toBe("No issues match.");

    const bad = await client.callTool({ name: "issues_search", arguments: { query: "a\u0001" } });
    expect(bad.isError).toBe(true);
    expect(structured(bad)).toMatchObject({ format: "ark-error/v1", error: { code: "usage" } });
  });

  it("issues_get returns showIssue's document with the MCP header first", async () => {
    const { r, ids } = await setup();
    const client = await connect(r);
    const now = await read(r);

    const dup = await client.callTool({ name: "issues_get", arguments: { id: "2" } });
    expect(structured(dup)).toEqual(
      json(showIssue(now, ids.b, { history: false, comments: true })),
    );
    const lines = text(dup).split("\n");
    expect(lines.slice(0, 3)).toEqual([
      `?2 (${ids.b}) · closed`,
      "DUPLICATE of ?1 (in-progress). Track work on ?1; read issues://issue/1.",
      "",
    ]);
    expect(lines[3]).toMatch(/^opened \d{4}-\d\d-\d\d$/);
    expect(text(dup)).toContain("# Safari login loops");
    expect(text(dup)).toContain(`duplicate-of ?1 Login fails on Safari (in-progress)`);

    const blocked = await client.callTool({ name: "issues_get", arguments: { id: "?3" } });
    expect(text(blocked).split("\n").slice(0, 2)).toEqual([
      `?3 (${ids.c}) · open`,
      "BLOCKED by ?1 (in-progress). Finish it first.",
    ]);

    const closed = await client.callTool({
      name: "issues_get",
      arguments: { id: ids.d, include_history: true, include_comments: false },
    });
    const d = structured(closed);
    expect(d).toEqual(json(showIssue(now, ids.d, { history: true, comments: false })));
    expect(d.comments).toBeNull();
    expect((d.events as unknown[]).length).toBeGreaterThan(0);
    expect(text(closed).split("\n")[1]).toMatch(
      /^CLOSED on \d{4}-\d\d-\d\d as done: dropped Safari 16\.$/,
    );
    expect(text(closed)).toContain("History:");

    const comments = await client.callTool({ name: "issues_get", arguments: { id: "4" } });
    expect(text(comments)).toContain("Comments:\n");
    expect(text(comments)).toContain("    Safari 16 only");

    const before = await read(r, "HEAD~1");
    const old = await client.callTool({
      name: "issues_get",
      arguments: { id: ids.d, ref: "HEAD~1" },
    });
    expect(structured(old)).toEqual(json(showIssue(before, resolveIssue(before, ids.d))));

    const noRef = await client.callTool({
      name: "issues_get",
      arguments: { id: ids.a, ref: "no-such-ref" },
    });
    expect(noRef.isError).toBe(true);
    expect(structured(noRef)).toMatchObject({ error: { code: "ref-not-found" } });

    const unknown = await client.callTool({ name: "issues_get", arguments: { id: "99" } });
    expect(unknown.isError).toBe(true);
    expect(structured(unknown)).toMatchObject({
      format: "ark-error/v1",
      error: { code: "usage", message: "unknown issue 99" },
    });
  });

  it("issues_list returns listIssues' document; assignee me is the person acted for", async () => {
    const { r, ids } = await setup();
    runIssues(r, ["assign", ids.e, "--set", ME, "--commit"]);
    const client = await connect(r);
    const now = await read(r);

    const def = await client.callTool({ name: "issues_list", arguments: {} });
    expect(structured(def)).toEqual(json(listIssues(now, {})));
    expect(text(def).split("\n")).toEqual([
      `?1         in-progress      Login fails on Safari`,
      `?3         open, blocked    Cache sessions`,
      `?5         open             Add dark mode  [type:feature]`,
    ]);

    const states = ["open", "in-progress", "closed"];
    const all = await client.callTool({ name: "issues_list", arguments: { state: states } });
    expect(structured(all)).toEqual(json(listIssues(now, { all: true })));
    expect(text(all)).toContain("closed (duplicate)");

    const mine = await client.callTool({
      name: "issues_list",
      arguments: { assignee: ["me"], label: ["type:feature"], limit: 5 },
    });
    expect(structured(mine)).toEqual(
      json(listIssues(now, { assignees: [ME], labels: ["type:feature"], limit: 5 })),
    );
    expect((structured(mine).issues as { id: string }[]).map((v) => v.id)).toEqual([ids.e]);

    const empty = await client.callTool({ name: "issues_list", arguments: { label: ["nope"] } });
    expect(text(empty)).toBe("No issues.");
  });

  it("answers a log that can't be read now with an ark-error/v1 result", async () => {
    const { r } = await setup();
    const client = await connect(r);
    await writeFile(join(r.root, "docs/issues/issues.toml"), "[log\n");
    const calls: [string, Record<string, unknown>][] = [
      ["issues_list", {}],
      ["issues_get", { id: "1" }],
      ["issues_search", { query: "safari" }],
    ];
    for (const [name, args] of calls) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      expect(structured(res), name).toMatchObject({
        format: "ark-error/v1",
        error: { code: "config" },
      });
    }
  });

  it("assignee me takes the git identity without ARK_ON_BEHALF_OF, and fails without either", async () => {
    const { r } = await setup();
    const asGit = await connect(r, {});
    const git = await asGit.callTool({ name: "issues_list", arguments: { assignee: ["me"] } });
    expect(structured(git)).toMatchObject({ filter: { assignees: ["ledger-test@example.com"] } });

    const nobody = await connect(r, {
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    const me = await nobody.callTool({ name: "issues_list", arguments: { assignee: ["me"] } });
    expect(me.isError).toBe(true);
    expect(structured(me)).toMatchObject({
      error: { code: "config", message: expect.stringMatching(/^no git identity/) },
    });
    const mine = await nobody.callTool({ name: "issues_ready", arguments: { mine: true } });
    expect(structured(mine)).toMatchObject({
      error: { code: "config", message: expect.stringMatching(/^no git identity/) },
    });
    const plain = await nobody.callTool({ name: "issues_list", arguments: {} });
    expect(plain.isError).toBeUndefined();
    const ready = await nobody.callTool({ name: "issues_ready", arguments: {} });
    expect(ready.isError).toBeUndefined();
  });

  it("issues_ready returns readyIssues' document; mine adds your assigned issues first", async () => {
    const { r, ids } = await setup();
    const client = await connect(r);
    const now = await read(r);
    const ready = await client.callTool({ name: "issues_ready", arguments: {} });
    expect(structured(ready)).toEqual(json(readyIssues(now, {})));
    expect(text(ready)).toBe("?5         open             Add dark mode  [type:feature]");

    runIssues(r, ["assign", ids.e, "--set", ME, "--commit"]);
    const after = await read(r);
    const none = await client.callTool({ name: "issues_ready", arguments: {} });
    expect(text(none)).toBe("No ready issues.");
    const mine = await client.callTool({
      name: "issues_ready",
      arguments: { mine: true, label: ["type:feature"], limit: 3 },
    });
    expect(structured(mine)).toEqual(
      json(readyIssues(after, { mine: ME, labels: ["type:feature"], limit: 3 })),
    );
    expect((structured(mine).issues as { id: string }[]).map((v) => v.id)).toEqual([ids.e]);
  });

  it("issues_for_path returns issuesFor's document, with each header's warning", async () => {
    const { r, ids } = await setup({ "src/auth/token.ts": `// issue:${"x".repeat(8)}\n` });
    runIssues(r, ["scope", ids.c, "--set", "src/auth/**", "--commit"]);
    const client = await connect(r);
    const now = await read(r);
    const log = await openIssueLog({ cwd: r.root, gitOptions: { env: r.env } });
    const paths = ["src/auth/session.ts", "src/auth/token.ts", "README.md", "new.ts"];
    const res = await client.callTool({ name: "issues_for_path", arguments: { paths } });
    expect(structured(res)).toEqual(json(await issuesFor(now, log, { paths })));
    expect(text(res).split("\n")).toEqual([
      "src/auth/session.ts",
      "  ?1 in-progress Login fails on Safari (via src/auth/**)",
      "  ?3 open Cache sessions (via src/auth/**)",
      "    BLOCKED by ?1 (in-progress). Finish it first.",
      "src/auth/token.ts",
      "  ?1 in-progress Login fails on Safari (via src/auth/**)",
      "  ?3 open Cache sessions (via src/auth/**)",
      "    BLOCKED by ?1 (in-progress). Finish it first.",
      "  unresolved: xxxxxxxx (line 1, not in this log)",
      "README.md",
      "  no issues",
      "new.ts (untracked)",
      "  no issues",
    ]);
    for (const bad of [["src/auth"], ["../outside.ts"]]) {
      const err = await client.callTool({ name: "issues_for_path", arguments: { paths: bad } });
      expect(err.isError, bad[0]).toBe(true);
      expect(structured(err)).toMatchObject({ error: { code: "usage" } });
    }
  });

  it("issues_templates returns listTemplates' document", async () => {
    const { r } = await setup();
    const client = await connect(r);
    const res = await client.callTool({ name: "issues_templates", arguments: {} });
    expect(structured(res)).toEqual(json(await listTemplates(await read(r))));
    const lines = text(res).split("\n");
    expect(lines).toContain("task v1 (repo) default");
    expect(lines).toContain("bug v1 (builtin)");
    expect(lines).toContain(
      "  done: Done when (required) — Observable conditions that make this issue finished.",
    );
    expect(lines).toContain(
      "  notes: Notes (optional) — Context, links and anything the person doing it should know.",
    );
  });

  it("source reads a [[sources]] log from the cache only", async () => {
    const s = await issueSource(["Provide the platform API"]);
    repos.push(s.src, s.bare);
    const r = await cliRepo({
      "docs/issues/issues.toml": `[log]\nindex = "committed"\n${sourceToml("platform", s.url)}${sourceToml("decisions", s.url, { kind: "adr" })}`,
    });
    repos.push(r);
    newIssue(r, "Use the platform API");
    const trace = join(r.root, "..", "mcp-trace.json");
    const client = await connect(r, { ARK_ON_BEHALF_OF: ME, GIT_TRACE2_EVENT: trace });

    const before = await client.callTool({
      name: "issues_list",
      arguments: { source: "platform" },
    });
    expect(structured(before)).toMatchObject({ source: "platform", issues: [] });
    expect(structured(before).notes).toContain("platform not fetched; run issues sources fetch");

    expect(runIssues(r, ["sources", "fetch", "platform"]).status).toBe(0);
    const log = await openIssueLog({ cwd: r.root, gitOptions: { env: r.env } });
    const cached = await readSourceIssues(log, "platform");
    const list = await client.callTool({ name: "issues_list", arguments: { source: "platform" } });
    expect(structured(list)).toEqual(json(listIssues(cached, {})));
    const search = await client.callTool({
      name: "issues_search",
      arguments: { query: "api", source: "platform" },
    });
    expect(structured(search)).toEqual(
      json(searchIssues(cached, { query: "api", includeClosed: false, limit: 10 })),
    );
    expect(
      (structured(search).results as { issue: { id: string } }[]).map((x) => x.issue.id),
    ).toEqual([s.issues[0]]);
    expect(await networkCommands(trace)).toEqual([]);

    const adr = await client.callTool({ name: "issues_list", arguments: { source: "decisions" } });
    expect(adr.isError).toBe(true);
    expect(structured(adr)).toMatchObject({
      error: {
        code: "usage",
        message: "source decisions is a decision log; --source reads issue logs",
      },
    });
    const unknown = await client.callTool({
      name: "issues_search",
      arguments: { query: "x", source: "nope" },
    });
    expect(structured(unknown)).toMatchObject({ error: { code: "usage" } });
  });
});
