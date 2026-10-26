/**
 * End to end (design §13.3): the BUILT `adr mcp`, spawned over real stdio and driven by the MCP
 * SDK's client, in a temp git repository. Sessions run in order 1, 2, 3, 3b, 4, 5 and share the
 * repository, except Session 5, which starts from a fresh one.
 */
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI, cliRepo, hooksRepo, REPO_HUMAN, requireBuilt, runAdr } from "./test-support/cli.js";
import { cliEnv } from "./test-support/decision-arbs.js";

const ME = "niko@example.com";
const H = REPO_HUMAN.email ?? "";
const TIMEOUT = 120_000;
const INDEX = '[log]\nindex = "committed"\n';

/** Every section of nygard, with no word "order" in it. */
const section = (what: string) => [
  "--section",
  `context=${what} needs a decision.`,
  "--section",
  `decision=We will settle ${what}.`,
  "--section",
  "scope=services/sessions",
  "--section",
  "consequences=One more thing to run.",
];
const ORDERS = {
  context: "Every service that writes orders needs a store.",
  decision: "We will use the store for orders.",
  scope: "src/orders/**",
  consequences: "One more service to run.",
};
const orderSections = (store: string) =>
  Object.entries({ ...ORDERS, decision: `We will use ${store} for orders.` }).flatMap(([k, v]) => [
    "--section",
    `${k}=${v}`,
  ]);
const COMPLETE = {
  context: "Sessions are slow.",
  decision: "We will cache them.",
  scope: "services/sessions",
  consequences: "A cache to run.",
};

interface Session {
  readonly client: Client;
  readonly stderr: () => string;
  readonly exit: Promise<number | null>;
  close(): Promise<number | null>;
}

/** Starts the built `adr mcp` in `repo` with the SDK's stdio client, named `e2e-agent`. */
async function startMcp(repo: TempRepo, env: NodeJS.ProcessEnv = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [requireBuilt(CLI), "mcp"],
    cwd: repo.root,
    // P10: a stdio client passes only a few variables unless given env explicitly.
    env: cliEnv(repo, env) as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  await client.connect(transport);
  // The SDK keeps the child private; its exit code is what `adr mcp` returns.
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  const exit = new Promise<number | null>((resolve) => {
    if (child === undefined) resolve(null);
    else child.once("exit", (code) => resolve(code));
  });
  return {
    client,
    stderr: () => stderr,
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
const rules = (r: unknown) => ((doc(r).findings ?? []) as { rule: string }[]).map((f) => f.rule);
const idOf = (r: unknown) => (doc(r).decision as { id: string }).id;
const cliJson = (repo: TempRepo, args: string[]) => {
  const out = runAdr(repo, [...args, "--json"]);
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Record<string, unknown>;
};

async function mcpError(p: Promise<unknown>): Promise<McpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpError);
  return err as McpError;
}

async function git(r: TempRepo, ...args: string[]): Promise<string> {
  return Buffer.from((await r.git.run(args)).stdout).toString("utf8");
}

describe("adr mcp over stdio (built)", () => {
  let r: TempRepo;
  const ids = { a: "", b: "", c: "", d: "", own: "", partial: "" };
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const out = runAdr(r, args, { env });
    expect(out.status, `${args.join(" ")}\n${out.stderr}`).toBe(0);
    return out;
  };
  const created = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    (JSON.parse(cli([...args, "--json"], env).stdout).decision as { id: string }).id;

  beforeAll(async () => {
    r = await cliRepo({ "adr.toml": INDEX, "src/orders/api.ts": "export {};\n" });
    cli(["init", "--commit"]);
    ids.a = created([
      "new",
      "Use DynamoDB for orders",
      ...orderSections("DynamoDB"),
      "--no-edit",
      "--commit",
    ]);
    cli(["scope", ids.a, "--set", "src/orders/**", "--commit"]);
    cli(["accept", ids.a, "--commit"]);
    ids.b = created([
      "new",
      "Use Aurora Serverless for orders",
      "--supersedes",
      ids.a,
      ...orderSections("Aurora Serverless"),
      "--no-edit",
      "--commit",
    ]);
    cli(["accept", ids.b, "--copy-scope", "--commit"]);
    const other = {
      GIT_AUTHOR_EMAIL: "other@example.com",
      GIT_COMMITTER_EMAIL: "other@example.com",
    };
    ids.c = created(
      ["new", "Cache session tokens", ...section("Caching"), "--no-edit", "--commit"],
      other,
    );
    ids.d = created([
      "new",
      "Batch the nightly export",
      ...section("Exporting"),
      "--no-edit",
      "--commit",
    ]);
  }, TIMEOUT);

  afterAll(async () => {
    await r?.dispose();
  });

  it(
    "session 1: reads, proposals, policy, resources and the prompt",
    async () => {
      const { a, b, c } = ids;
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });

      // 1. Eleven tools; a decision tool is absent and says why.
      const tools = (await s.client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual([
        "adr_search",
        "adr_get",
        "adr_list",
        "adr_templates",
        "adr_propose",
        "adr_update_draft",
        "adr_note",
        "adr_link",
        "adr_for_path",
        "adr_scope",
        "adr_withdraw",
      ]);
      const absent = await mcpError(call(s, "adr_accept", { id: b }));
      expect(absent.code).toBe(-32602);
      expect(absent.message).toContain("adr_accept is not available");
      expect(absent.message).toContain("mcp_can_decide");

      // 2. adr_list is adr list --json.
      expect(doc(await call(s, "adr_list"))).toEqual(cliJson(r, ["list"]));

      // 3. adr_search: active only by default, the inactive one counted; its warning with --all.
      const search = await call(s, "adr_search", { query: "orders" });
      expect(
        (doc(search).results as { decision: { id: string } }[]).map((x) => x.decision.id),
      ).toEqual([b]);
      expect(doc(search).inactive_omitted).toBe(1);
      expect(doc(search)).toEqual(cliJson(r, ["search", "orders"]));
      const all = await call(s, "adr_search", { query: "orders", include_inactive: true });
      expect(
        (doc(all).results as { decision: { id: string } }[]).map((x) => x.decision.id),
      ).toEqual([b, a]);
      expect(text(all)).toContain("SUPERSEDED by ADR-0002");
      expect(text(all)).toContain("adr://decision/ADR-0002");

      // 4. adr_get: the state header first, with the supersession warning; --ref; a bad ref.
      const get = await call(s, "adr_get", { id: "ADR-0001" });
      const lines = text(get).split("\n");
      expect(lines[0]).toBe(`ADR-0001 (${a}) · superseded`);
      expect(lines[1]).toMatch(
        /^SUPERSEDED by ADR-0002 .* read adr:\/\/decision\/ADR-0002 instead\.$/,
      );
      expect(text(get)).toContain("# Use DynamoDB for orders");
      expect(doc(get)).toEqual(cliJson(r, ["show", "1"]));
      const history = await call(s, "adr_get", { id: a, include_history: true });
      expect((doc(history).events as unknown[]).length).toBeGreaterThan(2);
      const old = await call(s, "adr_get", { id: "ADR-0001", ref: "HEAD~1" });
      expect(doc(old)).toEqual(cliJson(r, ["show", "1", "--ref", "HEAD~1"]));
      expect(doc(old).ref).toBe("HEAD~1");
      const bad = await call(s, "adr_get", { id: "ADR-0001", ref: "no-such-ref" });
      expect(bad.isError).toBe(true);
      expect(doc(bad)).toMatchObject({ format: "ark-error/v1", error: { code: "ref-not-found" } });

      // 5. adr_for_path is adr for --json; the superseded one carries its warning.
      const forPath = await call(s, "adr_for_path", { paths: ["src/orders/api.ts"] });
      expect(doc(forPath)).toEqual(cliJson(r, ["for", "src/orders/api.ts"]));
      const governing = (
        doc(forPath).paths as { decisions: { id: string; warning: string | null }[] }[]
      )[0]?.decisions;
      expect(governing?.map((x) => x.id)).toEqual([b, a]);
      expect(governing?.[1]?.warning).toContain("SUPERSEDED");
      expect(text(forPath)).toContain("read adr://decision/ADR-0002 instead.");

      // 6. adr_templates.
      const templates = doc(await call(s, "adr_templates")).templates as {
        name: string;
        sections: { id: string; required: boolean }[];
      }[];
      expect(templates.find((t) => t.name === "nygard")?.sections).toEqual([
        expect.objectContaining({ id: "context", required: true }),
        expect.objectContaining({ id: "decision", required: true }),
        expect.objectContaining({ id: "scope", required: true }),
        expect.objectContaining({ id: "consequences", required: true }),
      ]);

      // 7. adr_propose with structured sections; lint findings come back as data.
      const own = await call(s, "adr_propose", {
        title: "Cache session lookups",
        sections: COMPLETE,
      });
      expect(doc(own)).toMatchObject({ command: "new", ok: true, findings: [] });
      ids.own = idOf(own);
      expect(doc(own).notes).toEqual([]);
      const ownEvents = doc(await call(s, "adr_get", { id: ids.own, include_history: true }))
        .events as { type: string; actor: unknown }[];
      expect(ownEvents[0]).toMatchObject({
        type: "proposed",
        actor: { kind: "agent", name: "e2e-agent", agent: "e2e-agent", on_behalf_of: ME },
      });
      const partial = await call(s, "adr_propose", {
        title: "Shard the session store",
        sections: { context: "Too big." },
      });
      expect(doc(partial)).toMatchObject({ ok: true });
      expect(rules(partial)).toEqual([
        "template/guidance-left",
        "template/guidance-left",
        "template/guidance-left",
      ]);
      ids.partial = idOf(partial);
      const unknown = await call(s, "adr_propose", { title: "x", sections: { nope: "x" } });
      expect(doc(unknown)).toMatchObject({ error: { code: "usage" } });
      const typed = await call(s, "adr_propose", { title: 7 });
      expect(doc(typed)).toMatchObject({
        error: { code: "usage", message: expect.stringContaining("invalid input for adr_propose") },
      });

      // 8. adr_update_draft: own OK; accepted is not a draft; another person's is refused.
      const update = await call(s, "adr_update_draft", {
        id: ids.partial,
        sections: { decision: "We will shard.", scope: "services/sessions", consequences: "More." },
      });
      expect(doc(update)).toMatchObject({ command: "update", ok: true, findings: [] });
      expect(
        await readFile(join(r.root, (doc(update).written as string[])[0] ?? ""), "utf8"),
      ).toContain("## Decision\nWe will shard.\n");
      expect(
        rules(await call(s, "adr_update_draft", { id: b, sections: { context: "x" } })),
      ).toEqual(["decision/not-a-draft"]);
      expect(
        rules(await call(s, "adr_update_draft", { id: c, sections: { context: "x" } })),
      ).toEqual(["decision/mcp-cannot-decide"]);

      // 9. adr_note on a superseded decision; adr_link, then the same link again.
      expect(doc(await call(s, "adr_note", { id: a, text: "Kept for history." }))).toMatchObject({
        command: "note",
        ok: true,
      });
      const link = await call(s, "adr_link", { id: ids.own, to: b, rel: "depends-on" });
      expect(doc(link)).toMatchObject({ command: "link", ok: true });
      const again = await call(s, "adr_link", { id: ids.own, to: b, rel: "depends-on" });
      expect(doc(again)).toMatchObject({ ok: true, written: [] });
      expect(doc(again).notes).toEqual([expect.stringMatching(/^already linked: /)]);

      // 10. adr_scope: own proposal OK; an accepted decision and another's proposal refused.
      expect(
        doc(await call(s, "adr_scope", { id: ids.own, add: ["src/orders/**"] })),
      ).toMatchObject({
        command: "scope",
        ok: true,
      });
      const accepted = await call(s, "adr_scope", { id: b, remove: ["src/orders/**"] });
      expect(doc(accepted)).toMatchObject({ ok: false, written: [] });
      expect(rules(accepted)).toEqual(["decision/mcp-cannot-decide"]);
      expect(rules(await call(s, "adr_scope", { id: c, add: ["src/**"] }))).toEqual([
        "decision/mcp-cannot-decide",
      ]);

      // 10b. adr_withdraw: own proposal staged as withdrawn; another's refused; an accepted one
      // refused by the state machine. The CLI's withdraw as an agent gives the same document.
      const retire = idOf(
        await call(s, "adr_propose", { title: "Retire the session cache", sections: COMPLETE }),
      );
      const withdrawn = await call(s, "adr_withdraw", {
        id: retire,
        reason: "The user decided against it.",
      });
      expect(doc(withdrawn)).toMatchObject({
        command: "withdraw",
        ok: true,
        commit: null,
        decision: { status: "withdrawn" },
      });
      expect(await git(r, "diff", "--cached", "--name-only")).toMatch(
        new RegExp(`events/${retire}/.*-withdrawn\\.yaml`),
      );
      const retireEvents = doc(await call(s, "adr_get", { id: retire, include_history: true }))
        .events as { type: string; actor: unknown }[];
      expect(retireEvents.at(-1)).toMatchObject({
        type: "withdrawn",
        actor: { kind: "agent", agent: "e2e-agent", on_behalf_of: ME },
      });
      const othersWithdraw = await call(s, "adr_withdraw", { id: c });
      expect(doc(othersWithdraw)).toMatchObject({ ok: false, written: [] });
      expect(rules(othersWithdraw)).toEqual(["decision/mcp-cannot-decide"]);
      expect(rules(await call(s, "adr_withdraw", { id: b }))).toEqual(["transition/illegal"]);
      const drop = created([
        "new",
        "Drop the session cache",
        ...section("Dropping"),
        "--no-edit",
        "--commit",
      ]);
      const cliWithdraw = JSON.parse(
        cli(["withdraw", drop, "--reason", "Not needed.", "--commit", "--json"], {
          ARK_AGENT: "kiro",
          ARK_ON_BEHALF_OF: ME,
        }).stdout,
      ) as Record<string, unknown>;
      expect(cliWithdraw).toMatchObject({ command: "withdraw", ok: true });
      expect((cliWithdraw.decision as { status: string }).status).toBe("withdrawn");
      expect(Object.keys(cliWithdraw)).toEqual(Object.keys(doc(withdrawn)));
      const dropEvents = cliJson(r, ["show", drop, "--history"]).events as {
        type: string;
        actor: unknown;
      }[];
      expect(dropEvents.at(-1)).toMatchObject({
        type: "withdrawn",
        actor: { kind: "agent", agent: "kiro", on_behalf_of: ME },
      });

      // 11. Resources, in all three id forms.
      expect((await s.client.listResources()).resources.map((x) => x.uri)).toEqual(["adr://index"]);
      expect(
        (await s.client.listResourceTemplates()).resourceTemplates.map((x) => x.uriTemplate),
      ).toEqual(["adr://decision/{id}"]);
      const index = (await s.client.readResource({ uri: "adr://index" })).contents[0] as {
        text: string;
      };
      expect(index.text).toContain("## Accepted");
      expect(index.text).toContain("| ADR-0002 |");
      const forms = [];
      for (const form of [a, "1", "ADR-0001"]) {
        const c0 = (await s.client.readResource({ uri: `adr://decision/${form}` })).contents[0] as {
          text: string;
        };
        forms.push(c0.text);
      }
      expect(new Set(forms).size).toBe(1);
      expect(forms[0]?.split("\n").slice(0, 2)).toEqual([
        `ADR-0001 (${a}) · superseded`,
        expect.stringContaining("read adr://decision/ADR-0002 instead."),
      ]);
      const missing = await mcpError(s.client.readResource({ uri: "adr://decision/zzzzzzzz" }));
      expect(missing.code).toBe(-32002);
      const qualified = await mcpError(s.client.readResource({ uri: "adr://decision/a:b" }));
      expect(qualified.code).toBe(-32602);
      expect(qualified.message).toContain("in another log");

      // 12. The prompt.
      const [prompt] = (await s.client.listPrompts()).prompts;
      expect(prompt?.name).toBe("adr_draft_from_discussion");
      expect(prompt?.arguments?.map((x) => [x.name, x.required])).toEqual([
        ["title", false],
        ["template", false],
        ["supersedes", false],
      ]);
      const got = await s.client.getPrompt({
        name: "adr_draft_from_discussion",
        arguments: { title: "Cache order reads", supersedes: "2" },
      });
      expect(got.messages).toHaveLength(1);
      const body = (got.messages[0]?.content as { text?: string } | undefined)?.text ?? "";
      expect(body).toContain("2. Use the template nygard (version 1). Its sections:");
      expect(body).toContain("   - context: Context, required.");
      expect(body).toContain('"Cache order reads"');
      expect(body).toContain(`ADR-0002 (${b})`);
      const nope = await mcpError(
        s.client.getPrompt({ name: "adr_draft_from_discussion", arguments: { template: "nope" } }),
      );
      expect(nope.code).toBe(-32602);

      // 13. Closing the client ends the server with exit 0.
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session 2: attribution to the git identity without ARK_ON_BEHALF_OF",
    async () => {
      const { b, d } = ids;
      const s = await startMcp(r);
      const note = await call(s, "adr_note", { id: b, text: "Checked by an agent." });
      expect(doc(note).notes).toContain(
        `on_behalf_of taken from the git identity ${H}; set ARK_ON_BEHALF_OF to name who you act for`,
      );
      const events = doc(await call(s, "adr_get", { id: b, include_history: true })).events as {
        type: string;
        actor: Record<string, unknown>;
      }[];
      expect(events.at(-1)).toMatchObject({
        type: "noted",
        actor: { kind: "agent", agent: "e2e-agent", on_behalf_of: H },
      });
      // D was proposed by H with the CLI, so it is this agent's own proposal.
      expect(doc(await call(s, "adr_scope", { id: d, add: ["services/**"] }))).toMatchObject({
        ok: true,
      });
      expect(await s.close()).toBe(0);

      // D17: acting for someone else, the same call is refused.
      const other = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const refused = await call(other, "adr_scope", { id: d, add: ["docs/**"] });
      expect(doc(refused)).toMatchObject({ ok: false });
      expect(rules(refused)).toEqual(["decision/mcp-cannot-decide"]);
      expect(await other.close()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session 3 and 3b: the decision tools with mcp_can_decide, then turned off",
    async () => {
      const { b, c, d } = ids;
      await writeFile(join(r.root, "adr.toml"), `${INDEX}[policy]\nmcp_can_decide = true\n`);
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect((await s.client.listTools()).tools).toHaveLength(15);
      await expect
        .poll(() => s.stderr())
        .toContain(
          "adr: warning: adr_accept refuses agents while [policy] accept_requires_human is true",
        );
      const own = await call(s, "adr_accept", { id: ids.own });
      expect(doc(own)).toMatchObject({ ok: false });
      expect(rules(own)).toContain("decision/agent-accepted");
      expect(rules(await call(s, "adr_accept", { id: b }))).toEqual(
        expect.arrayContaining(["transition/illegal", "decision/agent-accepted"]),
      );
      const narrowed = await call(s, "adr_scope", { id: b, remove: ["src/orders/**"] });
      expect(doc(narrowed)).toMatchObject({ ok: true });
      expect((doc(narrowed).notes as string[]).join("\n")).toMatch(/narrow/);
      expect(doc(await call(s, "adr_scope", { id: b, add: ["src/orders/**"] }))).toMatchObject({
        ok: true,
      });
      expect(
        doc(await call(s, "adr_update_draft", { id: c, sections: { context: "Edited." } })),
      ).toMatchObject({
        ok: true,
      });
      expect(doc(await call(s, "adr_reject", { id: c, reason: "Not needed." }))).toMatchObject({
        command: "reject",
        ok: true,
      });
      // D was proposed for H; this server acts for ME, and mcp_can_decide lets it withdraw.
      expect(doc(await call(s, "adr_withdraw", { id: d }))).toMatchObject({
        command: "withdraw",
        ok: true,
      });
      expect(await s.close()).toBe(0);

      await writeFile(
        join(r.root, "adr.toml"),
        `${INDEX}[policy]\nmcp_can_decide = true\naccept_requires_human = false\n`,
      );
      const t = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const e = await call(t, "adr_propose", {
        title: "Use Aurora with read replicas for orders",
        sections: { ...ORDERS, decision: "We will add read replicas." },
      });
      expect(doc(e)).toMatchObject({ ok: true, findings: [] });
      const accepted = await call(t, "adr_accept", { id: idOf(e) });
      expect(doc(accepted)).toMatchObject({ command: "accept", ok: true, affected: [] });
      expect(await git(r, "diff", "--cached", "--name-only")).toContain("docs/adr/index.md");
      expect(doc(await call(t, "adr_supersede", { id: b, by: idOf(e) }))).toMatchObject({
        command: "supersede",
        ok: true,
      });
      expect(doc(await call(t, "adr_get", { id: b })).decision).toMatchObject({
        status: "superseded",
      });
      expect(
        doc(await call(t, "adr_deprecate", { id: idOf(e), reason: "Moving on." })),
      ).toMatchObject({
        command: "deprecate",
        ok: true,
      });

      // 3b: turned off while the server runs; the listed tool says to restart.
      await writeFile(join(r.root, "adr.toml"), `${INDEX}[policy]\nmcp_can_decide = false\n`);
      const off = await call(t, "adr_reject", { id: ids.partial, reason: "x" });
      expect(off.isError).toBe(true);
      expect(doc(off)).toMatchObject({
        error: { code: "usage", message: expect.stringContaining("restart adr mcp") },
      });
      expect(await t.close()).toBe(0);
    },
    TIMEOUT,
  );

  it("session 4: exits 2 before serving with an invalid ARK_ON_BEHALF_OF", () => {
    const out = runAdr(r, ["mcp"], { env: { ARK_ON_BEHALF_OF: "not-an-email" } });
    expect(out.status).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("ARK_ON_BEHALF_OF");
  });
});

describe("adr mcp with auto_commit and hooks (built)", () => {
  let r: TempRepo;
  beforeAll(async () => {
    r = await hooksRepo({ "adr.toml": `${INDEX}[policy]\nauto_commit = true\n` });
    for (const args of [["init"], ["hooks", "install"]]) {
      const out = runAdr(r, args);
      expect(out.status, out.stderr).toBe(0);
    }
  }, TIMEOUT);
  afterAll(async () => {
    await r?.dispose();
  });

  it(
    "session 5: commits complete drafts through the hooks and refuses incomplete ones",
    async () => {
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const before = await git(r, "status", "--porcelain");
      const head = await git(r, "rev-parse", "HEAD");

      const refused = await call(s, "adr_propose", {
        title: "Half a decision",
        sections: { context: "Why." },
      });
      expect(doc(refused)).toMatchObject({ ok: false, decision: null, written: [], commit: null });
      expect(rules(refused)).toContain("template/guidance-left");
      expect(text(refused).split("\n").at(-1)).toBe(
        "Fill in every required section and call adr_propose again.",
      );
      expect(await git(r, "status", "--porcelain")).toBe(before);
      expect(await git(r, "rev-parse", "HEAD")).toBe(head);

      const p = await call(s, "adr_propose", {
        title: "Cache session lookups",
        sections: COMPLETE,
      });
      expect(doc(p)).toMatchObject({ ok: true });
      expect(doc(p).commit).toBe((await git(r, "rev-parse", "HEAD")).trim());
      const id = idOf(p);
      expect((await git(r, "log", "-1", "--format=%s")).trim()).toBe(
        "docs(adr): propose to cache session lookups",
      );
      expect(await git(r, "log", "-1", "--format=%(trailers:only,unfold)")).toBe(
        `ADR: ${id}\nADR-Event: proposed\n\n`,
      );
      const check = runAdr(r, ["index", "--check", "--ref", "HEAD"]);
      expect(check.status, check.stdout + check.stderr).toBe(0);

      const body = (doc(p).written as string[])[0] ?? "";
      const text0 = await readFile(join(r.root, body), "utf8");
      const empty = await call(s, "adr_update_draft", { id, sections: { decision: "" } });
      expect(doc(empty)).toMatchObject({ ok: false, written: [] });
      expect(rules(empty)).toContain("template/section-empty");
      expect(await readFile(join(r.root, body), "utf8")).toBe(text0);

      const update = await call(s, "adr_update_draft", {
        id,
        sections: { decision: "We will cache them in Redis." },
      });
      expect(doc(update)).toMatchObject({ command: "update", ok: true });
      expect((await git(r, "log", "-1", "--format=%s")).trim()).toBe(
        `docs(adr): update the draft of ${id}`,
      );
      expect(await git(r, "show", `HEAD:${body}`)).toContain("We will cache them in Redis.");
      expect(runAdr(r, ["index", "--check", "--ref", "HEAD"]).status).toBe(0);

      const tokens = idOf(
        await call(s, "adr_propose", {
          title: "Cache session tokens in memory",
          sections: COMPLETE,
        }),
      );
      const withdrawn = await call(s, "adr_withdraw", { id: tokens });
      expect(doc(withdrawn)).toMatchObject({ command: "withdraw", ok: true });
      expect(doc(withdrawn).commit).toBe((await git(r, "rev-parse", "HEAD")).trim());
      expect((await git(r, "log", "-1", "--format=%s")).trim()).toBe(
        "docs(adr): withdraw the proposal to cache session tokens in memory",
      );
      expect(await git(r, "log", "-1", "--format=%(trailers:only,unfold)")).toBe(
        `ADR: ${tokens}\nADR-Event: withdrawn\n\n`,
      );
      expect(runAdr(r, ["verify"]).status).toBe(0);
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );
});
