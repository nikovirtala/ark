/**
 * End to end (design §6.9): the BUILT `issues mcp`, spawned over real stdio and driven by the MCP
 * SDK's client, in a temp git repository set up with the CLI. Session R1 reads with every tool
 * and resource; session R2 checks that a bad environment stops the server before it serves.
 */
import type { ChildProcess } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI, cliEnv, requireBuilt, runIssues } from "./test-support/cli.js";
import { cli, type McpIssues, ME, mcpError, mcpRepo } from "./test-support/mcp.js";
import { type IssueSourceFixture, issueSource, sourceToml } from "./test-support/sources.js";

const TIMEOUT = 120_000;

interface Session {
  readonly client: Client;
  readonly stderr: () => string;
  readonly exit: Promise<number | null>;
  close(): Promise<number | null>;
}

/** Starts the built `issues mcp` in `repo` with the SDK's stdio client, named `e2e-agent`. */
function spawnMcp(repo: TempRepo, env: NodeJS.ProcessEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [requireBuilt(CLI), "mcp"],
    cwd: repo.root,
    // P7: a stdio client passes only a few variables unless given env explicitly.
    env: cliEnv(repo, env) as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  return { transport, client, stderr: () => stderr };
}

/** The exit code of the transport's child process, once it has started. */
function exitOf(transport: StdioClientTransport): Promise<number | null> {
  // The SDK keeps the child private; its exit code is what `issues mcp` returns.
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  return new Promise((resolve) => {
    if (child === undefined) resolve(null);
    else if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

async function startMcp(repo: TempRepo, env: NodeJS.ProcessEnv = {}): Promise<Session> {
  const { transport, client, stderr } = spawnMcp(repo, env);
  await client.connect(transport);
  const exit = exitOf(transport);
  return {
    client,
    stderr,
    exit,
    async close() {
      await client.close();
      return exit;
    },
  };
}

const call = (s: Session, name: string, args: Record<string, unknown> = {}) =>
  s.client.callTool({ name, arguments: args });
const doc = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
const read = async (s: Session, uri: string) =>
  ((await s.client.readResource({ uri })).contents[0] as { text: string }).text;

describe("issues mcp over stdio (built)", () => {
  let r: TempRepo;
  let source: IssueSourceFixture;
  let ids: McpIssues;
  const cliJson = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    JSON.parse(cli(r, [...args, "--json"], env)) as Record<string, unknown>;

  beforeAll(async () => {
    source = await issueSource(["Remote Safari bug"]);
    const s = await mcpRepo({
      "docs/issues/issues.toml": `[log]\nindex = "committed"\n${sourceToml("platform", source.url)}`,
    });
    r = s.r;
    ids = s.ids;
    cli(r, ["sources", "fetch", "platform"]);
    // P6: the cached copy is what is read; the source repository itself is gone.
    await rename(source.bare.root, `${source.bare.root}.moved`);
  }, TIMEOUT);

  afterAll(async () => {
    await r?.dispose();
    await source?.src.dispose();
    await source?.bare.dispose();
  });

  it(
    "session R1: every read tool and resource",
    async () => {
      const { a, b, c, d, e } = ids;
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });

      // 1. The six read tools come first; a tool issues doesn't have is unknown.
      expect((await s.client.listTools()).tools.map((t) => t.name).slice(0, 6)).toEqual([
        "issues_search",
        "issues_get",
        "issues_list",
        "issues_ready",
        "issues_for_path",
        "issues_templates",
      ]);
      const work = await mcpError(call(s, "issues_work", { id: "1" }));
      expect(work.code).toBe(-32602);
      expect(work.message).toContain("unknown tool issues_work");

      // 2. issues_list is issues list --json, also for a cached source whose repository is gone.
      expect(doc(await call(s, "issues_list"))).toEqual(cliJson(["list"]));
      const all = await call(s, "issues_list", { state: ["open", "in-progress", "closed"] });
      expect(doc(all)).toEqual(cliJson(["list", "--all"]));
      const platform = await call(s, "issues_list", { source: "platform" });
      expect(doc(platform)).toEqual(cliJson(["list", "--source", "platform"]));
      expect((doc(platform).issues as { id: string }[]).map((v) => v.id)).toEqual(source.issues);

      // 3. issues_search: open ones by default, the closed matches counted.
      const search = await call(s, "issues_search", { query: "safari" });
      expect(doc(search)).toEqual(cliJson(["search", "safari"]));
      expect(doc(search)).toMatchObject({ total: 1, closed_omitted: 2 });
      expect((doc(search).results as { issue: { id: string } }[]).map((x) => x.issue.id)).toEqual([
        a,
      ]);
      const closed = await call(s, "issues_search", { query: "safari", include_closed: true });
      expect(doc(closed)).toEqual(cliJson(["search", "safari", "--all"]));
      expect(
        (doc(closed).results as { issue: { id: string } }[]).map((x) => x.issue.id).sort(),
      ).toEqual([a, b, d].sort());
      expect(text(closed)).toContain(
        "DUPLICATE of ?1 (in-progress). Track work on ?1; read issues://issue/1.",
      );
      const remote = await call(s, "issues_search", { query: "safari", source: "platform" });
      expect(doc(remote)).toEqual(cliJson(["search", "safari", "--source", "platform"]));
      expect(doc(remote).total).toBe(1);

      // 4. issues_get: the state header first, the document as issues show prints it.
      const dup = await call(s, "issues_get", { id: "2" });
      expect(text(dup).split("\n").slice(0, 2)).toEqual([
        `?2 (${b}) · closed`,
        "DUPLICATE of ?1 (in-progress). Track work on ?1; read issues://issue/1.",
      ]);
      expect(doc(dup)).toEqual(cliJson(["show", "2"]));
      const blocked = await call(s, "issues_get", { id: "?3" });
      expect(text(blocked).split("\n")[1]).toBe("BLOCKED by ?1 (in-progress). Finish them first.");
      const history = await call(s, "issues_get", { id: d, include_history: true });
      expect(doc(history)).toEqual(cliJson(["show", d, "--history"]));
      expect((doc(history).events as unknown[]).length).toBeGreaterThan(0);
      const bare = await call(s, "issues_get", { id: c, include_comments: false });
      expect(doc(bare)).toEqual(cliJson(["show", c, "--no-comments"]));
      const old = await call(s, "issues_get", { id: d, ref: "HEAD~1" });
      expect(doc(old)).toEqual(cliJson(["show", d, "--ref", "HEAD~1"]));

      // 5. issues_ready: E is ready, C (blocked) isn't; mine puts your assigned issues first.
      const ready = await call(s, "issues_ready");
      expect(doc(ready)).toEqual(cliJson(["ready"]));
      expect((doc(ready).issues as { id: string }[]).map((v) => v.id)).toEqual([e]);
      cli(r, ["assign", e, "--set", ME, "--commit"]);
      const mine = await call(s, "issues_ready", { mine: true });
      const agent = { ARK_AGENT: "e2e-agent", ARK_ON_BEHALF_OF: ME };
      expect(doc(mine)).toEqual(cliJson(["ready", "--mine"], agent));
      expect((doc(mine).issues as { id: string }[]).map((v) => v.id)).toEqual([e]);
      expect(text(await call(s, "issues_ready"))).toBe("No ready issues.");
      cli(r, ["assign", e, "--clear", "--commit"]);

      // 6. issues_for_path is issues for --json.
      const forPath = await call(s, "issues_for_path", { paths: ["src/auth/session.ts"] });
      expect(doc(forPath)).toEqual(cliJson(["for", "src/auth/session.ts"]));
      expect(text(forPath)).toContain("?1 in-progress Login fails on Safari (via src/auth/**)");

      // 7. issues_templates: the repo's task template and the other built-ins.
      const templates = await call(s, "issues_templates");
      expect(doc(templates)).toMatchObject({ format: "issues-templates/v1", default: "task" });
      expect(
        (doc(templates).templates as { name: string; source: string }[]).map((t) => [
          t.name,
          t.source,
        ]),
      ).toEqual([
        ["bug", "builtin"],
        ["feature", "builtin"],
        ["task", "repo"],
      ]);
      expect(text(templates)).toContain("  done: Done when (required)");

      // 8. Resources: the index, the ready list, and an issue by each of its id forms.
      expect((await s.client.listResources()).resources.map((x) => x.uri)).toEqual([
        "issues://index",
        "issues://ready",
      ]);
      expect(
        (await s.client.listResourceTemplates()).resourceTemplates.map((x) => x.uriTemplate),
      ).toEqual(["issues://issue/{id}"]);
      const forms = await Promise.all(
        [b, "2", "0002", "%3F2"].map((f) => read(s, `issues://issue/${f}`)),
      );
      expect(new Set(forms).size).toBe(1);
      expect((forms[0] ?? "").split("\n").slice(0, 4)).toEqual([
        `?2 (${b}) · closed`,
        "DUPLICATE of ?1 (in-progress). Track work on ?1; read issues://issue/1.",
        "",
        "# Safari login loops",
      ]);
      const literal = await mcpError(s.client.readResource({ uri: "issues://issue/?2" }));
      expect(literal.code).toBe(-32002);
      expect(await read(s, "issues://ready")).toBe(
        `# Ready issues\n\n- ?5 (${e}) Add dark mode [type:feature]\n`,
      );
      const index = await read(s, "issues://index");
      expect(index).toMatch(/## In progress\n\n\| Issue \|[^\n]*\n\|[^\n]*\n\| \?1 \|/);

      // 9. A log that can't be read now is an ark-error/v1 result; the next call reads it again.
      const config = join(r.root, "docs/issues/issues.toml");
      const good = await readFile(config, "utf8");
      await writeFile(config, "[log\n");
      const broken = await call(s, "issues_get", { id: "1" });
      expect(broken.isError).toBe(true);
      expect(doc(broken)).toMatchObject({ format: "ark-error/v1", error: { code: "config" } });
      await writeFile(config, good);
      expect((await call(s, "issues_get", { id: "1" })).isError).toBeUndefined();

      // 10. Closing the client ends the server with exit 0.
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "session R2: an invalid ARK_ON_BEHALF_OF exits 2 before serving",
    async () => {
      const { transport, client, stderr } = spawnMcp(r, { ARK_ON_BEHALF_OF: "not-an-email" });
      const connected = client.connect(transport).then(
        () => null,
        (err: unknown) => err,
      );
      expect(await exitOf(transport)).toBe(2);
      expect(await connected).toBeInstanceOf(Error);
      expect(stderr()).toBe(
        'issues: error: ARK_ON_BEHALF_OF "not-an-email" is not an email address\n',
      );
      expect(runIssues(r, ["list"]).status).toBe(0);
    },
    TIMEOUT,
  );
});
