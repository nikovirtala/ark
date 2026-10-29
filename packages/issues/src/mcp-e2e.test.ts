/**
 * End to end (design §6.9, §7.7): the BUILT `issues mcp`, spawned over real stdio and driven by
 * the MCP SDK's client, in a temp git repository set up with the CLI. Session R1 reads with every
 * tool and resource; session R2 checks that a bad environment stops the server before it serves.
 * Sessions W1–W9 write: every write tool, the close policy of design §7.3's Table A at startup and
 * while running, Table B over stdio, `auto_commit`, and who a write is recorded as (Table C).
 */
import type { ChildProcess } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLI,
  cliEnv,
  linkBins,
  REPO_HUMAN,
  requireBuilt,
  runGit,
  runIssues,
  WRITE_KEYS,
} from "./test-support/cli.js";
import {
  cli,
  type McpIssues,
  ME,
  mcpError,
  mcpRepo,
  type WriteIssues,
  writeRepo,
} from "./test-support/mcp.js";
import { type IssueSourceFixture, issueSource, sourceToml } from "./test-support/sources.js";
import { type RowRepo, runTableB, TABLE_B } from "./test-support/write-cells.js";

const TIMEOUT = 120_000;

interface Session {
  readonly client: Client;
  readonly stderr: () => string;
  readonly exit: Promise<number | null>;
  close(): Promise<number | null>;
}

/** Starts the built `issues mcp` in `repo` with the SDK's stdio client, named `e2e-agent`. */
function spawnMcp(repo: TempRepo, env: NodeJS.ProcessEnv, clientName = "e2e-agent") {
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
  const client = new Client({ name: clientName, version: "1.0.0" });
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

async function startMcp(
  repo: TempRepo,
  env: NodeJS.ProcessEnv = {},
  clientName?: string,
): Promise<Session> {
  const { transport, client, stderr } = spawnMcp(repo, env, clientName);
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

const READ_NAMES = [
  "issues_search",
  "issues_get",
  "issues_list",
  "issues_ready",
  "issues_for_path",
  "issues_templates",
];
const WRITE_NAMES = [
  "issues_open",
  "issues_update",
  "issues_comment",
  "issues_start",
  "issues_stop",
  "issues_close",
  "issues_link",
  "issues_unlink",
  "issues_label",
  "issues_assign",
  "issues_scope",
];
const ALL_NAMES = [...READ_NAMES, ...WRITE_NAMES];
const WITHOUT_CLOSE = ALL_NAMES.filter((n) => n !== "issues_close");
const CONFIG = "docs/issues/issues.toml";
const TASK = { goal: "Rotate the signing keys.", done: "Every key is rotated." };
const REASON = "Done when is met: the test checked it.";
const STARTUP_WARNING =
  "issues: warning: issues_close refuses agents while [policy] close_requires_human is true\n";
const NO_IDENTITY = {
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  GIT_CONFIG_GLOBAL: "/dev/null",
};

type WriteDoc = {
  ok: boolean;
  command: string;
  issue: { id: string; state: string; assignees: string[]; labels: string[] } | null;
  affected: { id: string }[];
  written: string[];
  commit: string | null;
  findings: { rule: string; message: string }[];
  notes: string[];
};

const names = async (s: Session) => (await s.client.listTools()).tools.map((t) => t.name);
const rules = (d: WriteDoc) => d.findings.map((f) => f.rule);
const git = (r: TempRepo, ...args: string[]) => {
  const out = runGit(r, args);
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout;
};
const lastEvent = (r: TempRepo, id: string) => {
  const shown = JSON.parse(cli(r, ["show", id, "--history", "--json"])) as {
    events: { type: string; actor: Record<string, unknown> }[];
  };
  return shown.events.at(-1);
};

/** A write tool's call, checked to be an `issues-write/v1` result of `command` (not `isError`). */
async function write(
  s: Session,
  name: string,
  args: Record<string, unknown>,
  command: string,
): Promise<WriteDoc & { text: string }> {
  const res = await call(s, name, args);
  expect(res.isError, `${name}: ${text(res)}`).toBeUndefined();
  const d = doc(res);
  expect(Object.keys(d).sort(), name).toEqual([...WRITE_KEYS]);
  expect(d, name).toMatchObject({ format: "issues-write/v1", command });
  return { ...(d as unknown as WriteDoc), text: text(res) };
}

async function setPolicy(r: TempRepo, toml: string, commit = false): Promise<void> {
  await writeFile(join(r.root, CONFIG), toml);
  if (commit) {
    git(r, "add", CONFIG);
    git(r, "commit", "-qm", "chore: set the issue log's policy");
  }
}

describe("issues mcp writes over stdio (built)", () => {
  const repos: TempRepo[] = [];
  afterAll(async () => {
    for (const r of repos.splice(0)) await r.dispose();
  });
  async function setup(
    files: Record<string, string> = {},
  ): Promise<{ r: TempRepo; ids: WriteIssues }> {
    const s = await writeRepo(files);
    repos.push(s.r);
    return s;
  }

  it(
    "session W1: every write tool, as the client acting for ARK_ON_BEHALF_OF",
    async () => {
      const { r, ids } = await setup({
        [CONFIG]: '[log]\nindex = "committed"\n\n[labels]\nexclusive = ["type"]\n',
      });
      const head = git(r, "rev-parse", "HEAD");
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });

      // Table A row 1: issues_close listed, issues_reopen answers −32602.
      expect(await names(s)).toEqual(ALL_NAMES);
      const reopen = await mcpError(call(s, "issues_reopen", { id: ids.d, reason: "x" }));
      expect(reopen.code).toBe(-32602);
      expect(reopen.message).toContain(
        "issues_reopen is not available: reopening is left to people",
      );

      // issues_open: complete, then only the goal (lint as data); the index stays fresh.
      const opened = await write(s, "issues_open", { title: "Rotate keys", sections: TASK }, "new");
      expect(opened).toMatchObject({ ok: true, findings: [], commit: null, notes: [] });
      expect(opened.written).toContain("docs/issues/index.md");
      const k = opened.issue?.id ?? "";
      expect(lastEvent(r, k)).toMatchObject({
        type: "opened",
        actor: { kind: "agent", agent: "e2e-agent", on_behalf_of: ME },
      });
      const draft = await write(
        s,
        "issues_open",
        { title: "Half done", sections: { goal: "Only the goal." }, labels: ["type:feature"] },
        "new",
      );
      expect(draft.ok).toBe(true);
      expect(rules(draft).length).toBeGreaterThan(0);
      expect(rules(draft).every((x) => x.startsWith("template/"))).toBe(true);
      expect(draft.text).toContain("Fill in: Done when");

      // issues_update fills in what the draft lacked.
      const filled = await write(
        s,
        "issues_update",
        { id: draft.issue?.id, sections: { done: "It is done." } },
        "edit",
      );
      expect(filled).toMatchObject({ ok: true, findings: [] });

      // issues_start assigns the person acted for; a blocked issue starts with a warning.
      const started = await write(s, "issues_start", { id: k }, "start");
      expect(started.issue).toMatchObject({ state: "in-progress", assignees: [ME] });
      const blocked = await write(s, "issues_start", { id: ids.c }, "start");
      expect(blocked.ok).toBe(true);
      expect(rules(blocked)).toContain("issue/started-blocked");
      const stopped = await write(
        s,
        "issues_stop",
        { id: k, reason: "waiting for review" },
        "stop",
      );
      expect(stopped.issue?.state).toBe("open");
      const comment = await write(
        s,
        "issues_comment",
        { id: ids.e, text: "Looked at it." },
        "comment",
      );
      expect(comment.text).toContain(`Commented on ?5 (${ids.e})`);

      // issues_link twice: the second writes nothing, with a note; then issues_unlink.
      const link = { id: k, to: ids.e, rel: "depends-on" };
      expect((await write(s, "issues_link", link, "link")).written.length).toBeGreaterThan(0);
      const again = await write(s, "issues_link", link, "link");
      expect(again).toMatchObject({ ok: true, written: [] });
      expect(again.notes.join("\n")).toContain("already linked");
      expect((await write(s, "issues_unlink", link, "unlink")).ok).toBe(true);

      // issues_label, issues_assign, issues_scope.
      const label = await write(s, "issues_label", { id: ids.e, add: ["type:bug"] }, "label");
      expect(label.issue?.labels).toEqual(["type:bug"]);
      expect(label.notes).toContain("replaced type:feature (type is exclusive)");
      const assign = await write(s, "issues_assign", { id: ids.e, add: ["me"] }, "assign");
      expect(assign.issue?.assignees).toEqual([ME]);
      const scope = await write(s, "issues_scope", { id: ids.e, add: ["src/later/**"] }, "scope");
      expect(scope.notes.join("\n")).toContain("src/later/** matches no tracked file");

      // issues_close: no reason is a refusal result, not an error; then with a reason.
      const bare = await write(s, "issues_close", { id: k }, "close");
      expect(bare.ok).toBe(false);
      expect(rules(bare)).toContain("issue/agent-reason-required");
      expect(bare.text).toContain("Call issues_close again with a reason");
      const done = await write(s, "issues_close", { id: k, reason: REASON }, "close");
      expect(done).toMatchObject({ ok: true, issue: { state: "closed" } });
      const dup = await write(
        s,
        "issues_close",
        { id: ids.g, resolution: "duplicate", of: ids.e, reason: "same work" },
        "close",
      );
      expect(dup.ok).toBe(true);
      expect(dup.affected.map((v) => v.id)).toEqual([ids.e]);
      const twice = await write(s, "issues_close", { id: k, reason: REASON }, "close");
      expect(twice.ok).toBe(false);
      expect(rules(twice)).toEqual(["transition/illegal"]);

      // Nothing was committed, everything is staged, and the staged index is current.
      expect(git(r, "rev-parse", "HEAD")).toBe(head);
      expect(git(r, "diff", "--name-only")).toBe("");
      expect(git(r, "diff", "--cached", "--name-only")).toContain("docs/issues/index.md");
      expect(runIssues(r, ["index", "--check"]).status).toBe(0);
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "session W2: mcp_can_close = false at startup, and turned on needs a restart",
    async () => {
      const { r, ids } = await setup();
      await setPolicy(r, "[policy]\nmcp_can_close = false\n", true);
      const off = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(off)).toEqual(WITHOUT_CLOSE);
      const close = await mcpError(call(off, "issues_close", { id: ids.e, reason: REASON }));
      expect(close.code).toBe(-32602);
      expect(close.message).toContain(
        `issues_close is not available: [policy] mcp_can_close is false in ${CONFIG}; a person closes issues with the issues CLI, or set it to true and restart issues mcp`,
      );
      const reopen = await mcpError(call(off, "issues_reopen", { id: ids.d, reason: "x" }));
      expect(reopen.message).toContain("reopening is left to people");
      // Turned on while running: still not listed until a restart.
      await setPolicy(r, "[policy]\nmcp_can_close = true\n", true);
      expect(await names(off)).toEqual(WITHOUT_CLOSE);
      expect(await off.close()).toBe(0);
      expect(off.stderr()).toBe("");
      const on = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(on)).toEqual(ALL_NAMES);
      expect(await on.close()).toBe(0);

      // Table A row 4: both keys set; not listed, and no warning.
      await setPolicy(r, "[policy]\nmcp_can_close = false\nclose_requires_human = true\n", true);
      const both = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(both)).toEqual(WITHOUT_CLOSE);
      const refused = await mcpError(call(both, "issues_close", { id: ids.e, reason: REASON }));
      expect(refused.message).toContain("mcp_can_close is false");
      expect(await both.close()).toBe(0);
      expect(both.stderr()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "session W3: close_requires_human = true warns at startup and refuses agents, not people",
    async () => {
      const { r, ids } = await setup();
      await setPolicy(r, "[policy]\nclose_requires_human = true\n", true);
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(s)).toEqual(ALL_NAMES);
      const close = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(close.ok).toBe(false);
      expect(rules(close)).toContain("issue/agent-closed");
      expect(close.text).toContain("The issue log's policy keeps closing to people");
      const reopen = await mcpError(call(s, "issues_reopen", { id: ids.d, reason: "x" }));
      expect(reopen.message).toContain("reopening is left to people");
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe(STARTUP_WARNING);

      // Table C, the CLI rows: a person's close isn't policed; an agent's is; agents may reopen.
      expect(runIssues(r, ["close", ids.e, "--reason", "done by hand"]).status).toBe(0);
      const agent = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: ME };
      const cliClose = runIssues(r, ["close", ids.g, "--reason", REASON, "--json"], { env: agent });
      expect(cliClose.status).toBe(1);
      expect(cliClose.stdout).toContain("issue/agent-closed");
      const cliReopen = runIssues(r, ["reopen", ids.e, "--reason", "not done after all"], {
        env: agent,
      });
      expect(cliReopen.status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session W4: policy keys changed while running take effect at the next close",
    async () => {
      const { r, ids } = await setup();
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      await setPolicy(r, "[policy]\nmcp_can_close = false\n");
      expect(await names(s)).toEqual(ALL_NAMES);
      const off = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(off.ok).toBe(false);
      expect(rules(off)).toContain("issue/agent-closed");

      await setPolicy(r, "[policy]\nclose_requires_human = true\n");
      const human = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(human.ok).toBe(false);
      expect(rules(human)).toContain("issue/agent-closed");

      await setPolicy(r, "[policy]\nclose_requires_human = false\n");
      const through = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(through).toMatchObject({ ok: true, issue: { state: "closed" } });
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "session W5: with auto_commit and the hooks, writes commit and incomplete ones are refused",
    async () => {
      const { r } = await setup({
        ".gitignore": "node_modules/\n",
        [CONFIG]: '[log]\nindex = "committed"\n\n[policy]\nauto_commit = true\n',
      });
      await linkBins(r.root);
      cli(r, ["hooks", "install"]);
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const status = git(r, "status", "--porcelain");
      const head = git(r, "rev-parse", "HEAD");

      const half = await write(
        s,
        "issues_open",
        { title: "Half done", sections: { goal: "Only the goal." } },
        "new",
      );
      expect(half).toMatchObject({ ok: false, issue: null, written: [], commit: null });
      expect(half.text).toContain("Fill in every required section and call issues_open again.");
      expect(git(r, "status", "--porcelain")).toBe(status);
      expect(git(r, "rev-parse", "HEAD")).toBe(head);

      const opened = await write(s, "issues_open", { title: "Rotate keys", sections: TASK }, "new");
      expect(opened.ok).toBe(true);
      expect(opened.commit).not.toBeNull();
      expect(opened.text).toContain(`Committed ${opened.commit?.slice(0, 7)}`);
      expect(git(r, "log", "-1", "--format=%s").trim()).toBe('docs(issues): open "rotate keys"');
      expect(git(r, "status", "--porcelain")).toBe(status);
      expect(runIssues(r, ["index", "--check"]).status).toBe(0);

      const id = opened.issue?.id ?? "";
      const update = await write(s, "issues_update", { id, sections: { done: "" } }, "edit");
      expect(update).toMatchObject({ ok: false, written: [], commit: null });
      expect(git(r, "status", "--porcelain")).toBe(status);

      const closed = await write(s, "issues_close", { id, reason: REASON }, "close");
      expect(closed.commit).not.toBeNull();
      expect(git(r, "log", "-1", "--format=%B")).toContain(`Issue: ${id}\nIssue-Event: closed`);
      // A closed issue isn't linted, so its update commits.
      const late = await write(s, "issues_update", { id, sections: { done: "" } }, "edit");
      expect(late.ok).toBe(true);
      expect(late.commit).not.toBeNull();
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session W6: without ARK_ON_BEHALF_OF, a write acts for the git identity, with a note",
    async () => {
      const { r, ids } = await setup();
      const s = await startMcp(r, {});
      const comment = await write(s, "issues_comment", { id: ids.e, text: "Noted." }, "comment");
      expect(comment.notes).toContain(
        `on_behalf_of taken from the git identity ${REPO_HUMAN.email}; set ARK_ON_BEHALF_OF to name who you act for`,
      );
      expect(comment.text).toContain(`Note: on_behalf_of taken from the git identity`);
      expect(lastEvent(r, ids.e)).toMatchObject({
        type: "commented",
        actor: { kind: "agent", agent: "e2e-agent", on_behalf_of: REPO_HUMAN.email },
      });
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );

  const tableB = (repo: RowRepo, files: Record<string, string> = {}) =>
    it(`session W7: Table B over stdio, the ${repo} rows`, async () => {
      const { r, ids } = await setup(files);
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const rows = TABLE_B.filter((x) => x.repo === repo);
      const n = await runTableB((name, args) => call(s, name, args), ids, rows, {
        setPolicy: (toml) => setPolicy(r, toml),
      });
      expect(n).toBeGreaterThanOrEqual(rows.length * 6);
      expect(await s.close()).toBe(0);
    }, 300_000);
  tableB("start");
  tableB("stop");
  tableB("close");
  tableB("shared");
  tableB("crh", { [CONFIG]: "[policy]\nclose_requires_human = true\n" });

  it(
    "session W8: without ARK_ON_BEHALF_OF and a git identity, every write is a config error",
    async () => {
      const { r, ids } = await setup();
      const s = await startMcp(r, NO_IDENTITY);
      const args: Record<string, Record<string, unknown>> = {
        issues_open: { title: "Nobody's" },
        issues_update: { id: ids.e, title: "Nobody's" },
        issues_comment: { id: ids.e, text: "x" },
        issues_start: { id: ids.e },
        issues_stop: { id: ids.a },
        issues_close: { id: ids.e, reason: REASON },
        issues_link: { id: ids.e, to: ids.g },
        issues_unlink: { id: ids.e, to: ids.g },
        issues_label: { id: ids.e, add: ["type:bug"] },
        issues_assign: { id: ids.e, add: ["me"] },
        issues_scope: { id: ids.e, add: ["README.md"] },
      };
      expect(Object.keys(args)).toEqual(WRITE_NAMES);
      const before = git(r, "status", "--porcelain");
      for (const [name, a] of [
        ...Object.entries(args),
        ["issues_list", { assignee: ["me"] }],
        ["issues_ready", { mine: true }],
      ] as const) {
        const res = await call(s, name, a);
        expect(res.isError, name).toBe(true);
        expect(doc(res), name).toMatchObject({
          format: "ark-error/v1",
          error: { code: "config", message: expect.stringMatching(/^no git identity/) },
        });
      }
      expect(git(r, "status", "--porcelain")).toBe(before);
      expect((await call(s, "issues_list")).isError).toBeUndefined();
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session W9: a client name that can't be an agent name is recorded as ARK_AGENT or mcp-client",
    async () => {
      const { r, ids } = await setup();
      const robot = await startMcp(r, { ARK_ON_BEHALF_OF: ME }, "🤖");
      const plain = await write(robot, "issues_comment", { id: ids.e, text: "1" }, "comment");
      expect(plain.notes).toContain(
        "the MCP client sent no usable name; recorded as agent mcp-client",
      );
      expect(lastEvent(r, ids.e)?.actor).toMatchObject({ kind: "agent", agent: "mcp-client" });
      expect(await robot.close()).toBe(0);

      const kiro = await startMcp(r, { ARK_ON_BEHALF_OF: ME, ARK_AGENT: "kiro" }, "🤖");
      const named = await write(kiro, "issues_comment", { id: ids.e, text: "2" }, "comment");
      expect(named.notes).toContain("the MCP client sent no usable name; recorded as agent kiro");
      expect(lastEvent(r, ids.e)?.actor).toMatchObject({
        kind: "agent",
        agent: "kiro",
        on_behalf_of: ME,
      });
      expect(await kiro.close()).toBe(0);
    },
    TIMEOUT,
  );
});
