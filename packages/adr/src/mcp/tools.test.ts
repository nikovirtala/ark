import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog, readDecisions } from "../log.js";
import { decisionsFor } from "../scope.js";
import { searchDecisions } from "../search.js";
import { listTemplates } from "../templates/list.js";
import {
  cliRepo,
  NYGARD_SECTIONS,
  REPO_HUMAN,
  seedDecision,
  seedSupersession,
} from "../test-support/cli.js";
import { listDecisions, showDecision } from "../views.js";
import { proposeDecision, rejectDecision } from "../write.js";
import { serveAdrMcp } from "./server.js";

const ME = "niko@example.com";
const repos: TempRepo[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closes.splice(0)) await c();
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await cliRepo({ "src/orders/api.ts": "export {};\n", ...files });
  repos.push(r);
  return r;
}

async function connect(
  r: TempRepo,
  env: NodeJS.ProcessEnv = { ARK_ON_BEHALF_OF: ME },
): Promise<{ client: Client; stderr: string[] }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const stderr: string[] = [];
  const served = serveAdrMcp({
    cwd: r.root,
    root: null,
    env: { ...r.env, ...env },
    version: "0.0.0-test",
    stderr: { write: (s) => void stderr.push(s) },
    transport: serverSide,
  });
  const client = new Client({ name: "tools-test", version: "1" });
  await client.connect(clientSide);
  closes.push(async () => {
    await client.close();
    await served;
  });
  return { client, stderr };
}

const json = (x: unknown) => JSON.parse(JSON.stringify(x));
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
const structured = (r: unknown) =>
  (r as { structuredContent: Record<string, unknown> }).structuredContent;
const rules = (r: unknown) =>
  ((structured(r).findings ?? []) as { rule: string }[]).map((f) => f.rule);
const open = (r: TempRepo, ref: string | null = null) =>
  openDecisionLog({ cwd: r.root, ref, gitOptions: { env: r.env } });

/** A superseded by B (ADR-0001, ADR-0002); C proposed by someone else; D rejected. */
async function fixture(r: TempRepo) {
  const a = await seedDecision(r, "Use DynamoDB for orders");
  const b = await seedDecision(r, "Use Aurora for orders");
  await seedSupersession(r, a, b);
  const log = await open(r);
  const other = { ...REPO_HUMAN, name: "Other", email: "other@example.com" };
  const c = await proposeDecision(
    log,
    { title: "Cache session tokens", sections: NYGARD_SECTIONS, actor: other },
    { commit: true },
  );
  const d = await seedDecision(r, "Batch the nightly export", { accept: false });
  await rejectDecision(
    await open(r),
    { id: d, reason: "not now", actor: REPO_HUMAN },
    { commit: true },
  );
  return { a, b, c: c.decision?.id ?? "", d };
}

async function mcpError(p: Promise<unknown>): Promise<McpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpError);
  return err as McpError;
}

describe("adr mcp tools", { timeout: 60_000 }, () => {
  it("lists the eleven tools, and every schema refuses a wrong type and an extra property", async () => {
    const r = await repo();
    const { client } = await connect(r);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([
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
    for (const t of tools) {
      const extra = await client.callTool({ name: t.name, arguments: { nope: 1 } });
      expect(extra.isError, t.name).toBe(true);
      expect(structured(extra), t.name).toMatchObject({ error: { code: "usage" } });
      const props = Object.keys((t.inputSchema.properties ?? {}) as object);
      const [first] = props;
      if (first === undefined) continue;
      const wrong = await client.callTool({ name: t.name, arguments: { [first]: { x: 1 } } });
      expect(wrong.isError, t.name).toBe(true);
      expect(structured(wrong), t.name).toMatchObject({
        error: { code: "usage", message: expect.stringMatching(/^invalid input for /) },
      });
    }
    const scope = await client.callTool({ name: "adr_scope", arguments: { id: "x" } });
    expect(structured(scope)).toMatchObject({
      error: {
        code: "usage",
        message: expect.stringContaining("at least one of set, add or remove"),
      },
    });
    const accept = await mcpError(client.callTool({ name: "adr_accept", arguments: { id: "x" } }));
    expect(accept.code).toBe(-32602);
    expect(accept.message).toContain("adr_accept is not available");
    expect(accept.message).toContain("mcp_can_decide is false in adr.toml (not present)");
  });

  it("returns the library's documents from the reads", async () => {
    const r = await repo();
    const { a, b } = await fixture(r);
    const { client } = await connect(r);
    const read = await readDecisions(await open(r));
    const call = async (name: string, args: Record<string, unknown>) =>
      structured(await client.callTool({ name, arguments: args }));
    expect(await call("adr_list", {})).toEqual(json(listDecisions(read)));
    expect(await call("adr_list", { status: ["accepted"], limit: 1 })).toEqual(
      json(listDecisions(read, { status: ["accepted"], limit: 1 })),
    );
    expect(await call("adr_search", { query: "orders", include_inactive: true })).toEqual(
      json(searchDecisions(read, { query: "orders", includeInactive: true, limit: 10 })),
    );
    expect(await call("adr_get", { id: "1", include_history: true })).toEqual(
      json(await showDecision(read, a, { history: true })),
    );
    expect(await call("adr_templates", {})).toEqual(json(await listTemplates(read)));
    const log = await open(r);
    expect(await call("adr_for_path", { paths: ["src/orders/api.ts"] })).toEqual(
      json(await decisionsFor(read, log, { paths: ["src/orders/api.ts"] })),
    );
    const at = await readDecisions(await open(r, "HEAD~1"));
    expect(await call("adr_get", { id: b, ref: "HEAD~1" })).toEqual(
      json(await showDecision(at, b)),
    );
    const missing = await client.callTool({
      name: "adr_get",
      arguments: { id: b, ref: "no-such-ref" },
    });
    expect(missing.isError).toBe(true);
    expect(structured(missing)).toMatchObject({ error: { code: "ref-not-found" } });
    const unknown = await client.callTool({ name: "adr_get", arguments: { id: "zzzzzzzz" } });
    expect(structured(unknown)).toMatchObject({ error: { code: "usage" } });
  });

  it("renders texts with adr:// headers first", async () => {
    const r = await repo();
    const { a, b } = await fixture(r);
    const { client } = await connect(r);
    const get = text(await client.callTool({ name: "adr_get", arguments: { id: "ADR-0001" } }));
    expect(get.split("\n").slice(0, 3)).toEqual([
      `ADR-0001 (${a}) · superseded`,
      expect.stringMatching(
        /^SUPERSEDED by ADR-0002 \(accepted .*\)\. Do not apply this decision; read adr:\/\/decision\/ADR-0002 instead\.$/,
      ),
      "",
    ]);
    expect(get).toContain("Title: Use DynamoDB for orders");
    const search = text(
      await client.callTool({ name: "adr_search", arguments: { query: "aurora" } }),
    );
    expect(search.split("\n")[0]).toBe(`ADR-0002 (${b}) · accepted`);
    expect(search).toContain("1 of 1 shown");
    const list = text(await client.callTool({ name: "adr_list", arguments: {} }));
    expect(list.split("\n")[0]).toBe(
      `ADR-0001 (${a}) · superseded · Use DynamoDB for orders → ADR-0002`,
    );
    const templates = text(await client.callTool({ name: "adr_templates", arguments: {} }));
    expect(templates).toContain("nygard v1 (repo) default\n  context: Context (required) — ");
    const forPath = text(
      await client.callTool({ name: "adr_for_path", arguments: { paths: ["src/orders/api.ts"] } }),
    );
    expect(forPath.split("\n")[0]).toBe("src/orders/api.ts");
    const none = text(await client.callTool({ name: "adr_search", arguments: { query: "zebra" } }));
    expect(none).toBe("No decisions match.");
  });

  it("proposes with sections, returning lint findings as data", async () => {
    const r = await repo();
    const { client } = await connect(r);
    const partial = await client.callTool({
      name: "adr_propose",
      arguments: { title: "Shard orders", sections: { context: "Too big." } },
    });
    expect(structured(partial)).toMatchObject({ format: "adr-write/v1", command: "new", ok: true });
    expect(rules(partial)).toEqual([
      "template/guidance-left",
      "template/guidance-left",
      "template/guidance-left",
    ]);
    const id = (structured(partial).decision as { id: string }).id;
    expect(text(partial).split("\n")).toEqual([
      `${id} · proposed`,
      "",
      `Proposed ${id}: Shard orders`,
      `  docs/adr/decisions/${id}-shard-orders.md`,
      "Fill in: Decision (guidance)",
      "Fill in: Scope (guidance)",
      "Fill in: Consequences (guidance)",
      `Next: ask a human to review and accept it (adr accept ${id})`,
    ]);
    const unknown = await client.callTool({
      name: "adr_propose",
      arguments: { title: "x", sections: { nope: "x" } },
    });
    expect(structured(unknown)).toMatchObject({ error: { code: "usage" } });
  });

  it("refuses an incomplete draft under auto_commit, saying to send every section", async () => {
    const r = await repo({ "adr.toml": "[policy]\nauto_commit = true\n" });
    const { client } = await connect(r);
    const p = await client.callTool({
      name: "adr_propose",
      arguments: { title: "Shard orders", sections: { context: "Too big." } },
    });
    expect(structured(p)).toMatchObject({ ok: false, decision: null, written: [] });
    const lines = text(p).split("\n");
    expect(lines[0]).toBe("Refused:");
    expect(lines.at(-1)).toBe("Fill in every required section and call adr_propose again.");
  });

  it("updates own drafts, and leaves illegal cells to the library", async () => {
    const r = await repo();
    const { b, c, d } = await fixture(r);
    const { client } = await connect(r);
    const p = await client.callTool({
      name: "adr_propose",
      arguments: { title: "Shard orders", sections: { context: "Too big." } },
    });
    const id = (structured(p).decision as { id: string }).id;
    const update = await client.callTool({
      name: "adr_update_draft",
      arguments: { id, sections: { decision: "Shard.", scope: "src/**", consequences: "More." } },
    });
    expect(structured(update)).toMatchObject({ command: "update", ok: true, findings: [] });
    expect(text(update)).toContain(`Updated the draft of ${id}: decision, scope, consequences`);
    const notDraft = await client.callTool({
      name: "adr_update_draft",
      arguments: { id: b, sections: { context: "x" } },
    });
    expect(rules(notDraft)).toEqual(["decision/not-a-draft"]);
    const rejected = await client.callTool({
      name: "adr_update_draft",
      arguments: { id: d, sections: { context: "x" } },
    });
    expect(rules(rejected)).toEqual(["decision/not-a-draft"]);
    const others = await client.callTool({
      name: "adr_update_draft",
      arguments: { id: c, sections: { context: "x" } },
    });
    expect(structured(others)).toMatchObject({ ok: false, command: "update", written: [] });
    expect(rules(others)).toEqual(["decision/mcp-cannot-decide"]);
    expect(text(others).split("\n")[2]).toBe("Refused:");
    const incomplete = await client.callTool({
      name: "adr_update_draft",
      arguments: { id, sections: { decision: "" } },
    });
    expect(structured(incomplete)).toMatchObject({ ok: true });
    expect(rules(incomplete)).toEqual(["template/section-empty"]);
  });

  it("scopes own proposals, refuses others and accepted ones, and leaves illegal cells", async () => {
    const r = await repo();
    const { a, b, c, d } = await fixture(r);
    const { client } = await connect(r);
    const p = await client.callTool({
      name: "adr_propose",
      arguments: { title: "Shard orders", sections: NYGARD_SECTIONS },
    });
    const id = (structured(p).decision as { id: string }).id;
    const own = await client.callTool({
      name: "adr_scope",
      arguments: { id, add: ["src/orders/**"] },
    });
    expect(structured(own)).toMatchObject({ command: "scope", ok: true });
    expect(text(own).split("\n").slice(2, 4)).toEqual(["+ src/orders/**", "= src/orders/**"]);
    for (const target of [b, c]) {
      const refused = await client.callTool({
        name: "adr_scope",
        arguments: { id: target, add: ["src/**"] },
      });
      expect(rules(refused), target).toEqual(["decision/mcp-cannot-decide"]);
    }
    for (const target of [a, d]) {
      const illegal = await client.callTool({
        name: "adr_scope",
        arguments: { id: target, add: ["src/**"] },
      });
      expect(rules(illegal), target).toEqual(["transition/illegal"]);
    }
  });

  it("withdraws own proposals, refuses others' and leaves non-proposals to the state machine", async () => {
    const r = await repo();
    const { a, b, c, d } = await fixture(r);
    const { client } = await connect(r);
    const propose = async (title: string) =>
      (
        structured(
          await client.callTool({
            name: "adr_propose",
            arguments: { title, sections: NYGARD_SECTIONS },
          }),
        ).decision as { id: string }
      ).id;
    const id = await propose("Shard orders");
    const own = await client.callTool({
      name: "adr_withdraw",
      arguments: { id, reason: "The user decided against it." },
    });
    expect(structured(own)).toMatchObject({
      format: "adr-write/v1",
      command: "withdraw",
      ok: true,
      decision: { id, status: "withdrawn" },
      commit: null,
      findings: [],
    });
    expect(structured(own).written).toEqual([expect.stringMatching(/events\/.*-withdrawn\.yaml$/)]);
    expect(text(own)).toContain(`Withdrawn ${id}`);
    const withdrawn = (await readDecisions(await open(r))).folded.subjects
      .get(id)
      ?.applied.at(-1)?.event;
    expect(withdrawn).toMatchObject({ type: "withdrawn", reason: "The user decided against it." });
    expect(withdrawn?.actor).toEqual({
      kind: "agent",
      name: "tools-test",
      email: null,
      agent: "tools-test",
      on_behalf_of: ME,
    });
    const again = await client.callTool({ name: "adr_withdraw", arguments: { id } });
    expect(rules(again)).toEqual(["transition/illegal"]);
    const others = await client.callTool({ name: "adr_withdraw", arguments: { id: c } });
    expect(structured(others)).toMatchObject({ command: "withdraw", ok: false, written: [] });
    expect(rules(others)).toEqual(["decision/mcp-cannot-decide"]);
    expect((structured(others).findings as { message: string }[])[0]?.message).toContain(
      "withdrawing another person's proposal",
    );
    expect((await readDecisions(await open(r))).projection.views.get(c)?.status).toBe("proposed");
    for (const target of [b, a, d]) {
      const illegal = await client.callTool({ name: "adr_withdraw", arguments: { id: target } });
      expect(rules(illegal), target).toEqual(["transition/illegal"]);
    }
    const blank = await client.callTool({
      name: "adr_withdraw",
      arguments: { id: await propose("Shard invoices"), reason: "  " },
    });
    expect(blank.isError).toBe(true);
    expect(structured(blank)).toMatchObject({ error: { code: "usage" } });
  });

  it("withdraws the git identity's own proposal without ARK_ON_BEHALF_OF", async () => {
    const r = await repo();
    const id = await seedDecision(r, "Use Redis for sessions", { accept: false });
    const { client } = await connect(r, {});
    const own = await client.callTool({ name: "adr_withdraw", arguments: { id } });
    expect(structured(own)).toMatchObject({ command: "withdraw", ok: true });
    expect(structured(own).notes).toEqual(
      expect.arrayContaining([expect.stringContaining("on_behalf_of taken from the git identity")]),
    );
  });

  it("notes and links, attributing writes to the client", async () => {
    const r = await repo();
    const { a, b } = await fixture(r);
    const { client } = await connect(r);
    const note = await client.callTool({ name: "adr_note", arguments: { id: a, text: "Hm." } });
    expect(structured(note)).toMatchObject({ command: "note", ok: true, notes: [] });
    expect(text(note)).toContain(`Noted on ADR-0001 (${a})`);
    const log = await open(r);
    const read = await readDecisions(log);
    const noted = read.folded.subjects.get(a)?.applied.at(-1)?.event;
    expect(noted?.actor).toEqual({
      kind: "agent",
      name: "tools-test",
      email: null,
      agent: "tools-test",
      on_behalf_of: ME,
    });
    const link = await client.callTool({
      name: "adr_link",
      arguments: { id: a, to: "2", rel: "refines" },
    });
    expect(text(link)).toContain(`Linked ADR-0001 (${a}) refines ADR-0002 (${b})`);
    const again = await client.callTool({
      name: "adr_link",
      arguments: { id: a, to: "2", rel: "refines" },
    });
    expect(structured(again)).toMatchObject({ ok: true, written: [] });
    expect(text(again)).toContain("Note: already linked");
    const self = await client.callTool({ name: "adr_link", arguments: { id: a, to: a } });
    expect(structured(self)).toMatchObject({ error: { code: "usage" } });
  });

  it("notes the git identity without ARK_ON_BEHALF_OF", async () => {
    const r = await repo();
    const { b } = await fixture(r);
    const { client } = await connect(r, {});
    const note = await client.callTool({ name: "adr_note", arguments: { id: b, text: "Hm." } });
    expect(structured(note).notes).toEqual([
      "on_behalf_of taken from the git identity ledger-test@example.com; set ARK_ON_BEHALF_OF to name who you act for",
    ]);
    expect(text(note)).toContain(
      "Note: on_behalf_of taken from the git identity ledger-test@example.com",
    );
  });
});

describe("adr mcp decision tools", { timeout: 60_000 }, () => {
  const DECIDE = "[policy]\nmcp_can_decide = true\n";

  it("lists all fifteen with mcp_can_decide, and warns about accept_requires_human", async () => {
    const r = await repo({ "adr.toml": DECIDE });
    const { client, stderr } = await connect(r);
    expect((await client.listTools()).tools.map((t) => t.name).slice(11)).toEqual([
      "adr_accept",
      "adr_reject",
      "adr_deprecate",
      "adr_supersede",
    ]);
    expect(stderr).toEqual([
      "adr: warning: adr_accept refuses agents while [policy] accept_requires_human is true\n",
    ]);
    const quiet = await repo({ "adr.toml": `${DECIDE}accept_requires_human = false\n` });
    expect((await connect(quiet)).stderr).toEqual([]);
  });

  it("refuses agents' acceptance under accept_requires_human, with every finding", async () => {
    const r = await repo({ "adr.toml": DECIDE });
    const { b } = await fixture(r);
    const { client } = await connect(r);
    const p = await client.callTool({
      name: "adr_propose",
      arguments: { title: "Shard orders", sections: NYGARD_SECTIONS },
    });
    const id = (structured(p).decision as { id: string }).id;
    const own = await client.callTool({ name: "adr_accept", arguments: { id } });
    expect(structured(own)).toMatchObject({ command: "accept", ok: false });
    expect(rules(own)).toContain("decision/agent-accepted");
    const accepted = await client.callTool({ name: "adr_accept", arguments: { id: b } });
    expect(rules(accepted)).toEqual(
      expect.arrayContaining(["transition/illegal", "decision/agent-accepted"]),
    );
  });

  it("decides as the CLI does, with the policy lifted", async () => {
    const r = await repo({ "adr.toml": `${DECIDE}accept_requires_human = false\n` });
    const { a, b, c } = await fixture(r);
    const { client } = await connect(r);
    const scoped = await client.callTool({
      name: "adr_scope",
      arguments: { id: b, add: ["src/orders/**"] },
    });
    expect(structured(scoped)).toMatchObject({ ok: true });
    const others = await client.callTool({
      name: "adr_update_draft",
      arguments: { id: c, sections: { context: "Edited." } },
    });
    expect(structured(others)).toMatchObject({ ok: true });
    const reject = await client.callTool({
      name: "adr_reject",
      arguments: { id: c, reason: "Not needed." },
    });
    expect(structured(reject)).toMatchObject({ command: "reject", ok: true });
    expect(text(reject)).toContain(`Rejected ${c}`);
    const again = await client.callTool({ name: "adr_reject", arguments: { id: c, reason: "x" } });
    expect(rules(again)).toEqual(["transition/illegal"]);
    const p = await client.callTool({
      name: "adr_propose",
      arguments: { title: "Use Aurora with replicas", sections: NYGARD_SECTIONS },
    });
    const e = (structured(p).decision as { id: string }).id;
    expect(text(p)).toContain(`Next: adr_accept or adr accept ${e}`);
    const accept = await client.callTool({
      name: "adr_accept",
      arguments: { id: e, copy_scope: true },
    });
    expect(structured(accept)).toMatchObject({ command: "accept", ok: true, affected: [] });
    const supersede = await client.callTool({
      name: "adr_supersede",
      arguments: { id: b, by: e },
    });
    expect(structured(supersede)).toMatchObject({ command: "supersede", ok: true });
    expect(text(supersede).split("\n")[0]).toBe(`ADR-0002 (${b}) · superseded`);
    expect(text(supersede)).toContain(`Superseded ADR-0002 (${b}) by ${e}`);
    const deprecate = await client.callTool({
      name: "adr_deprecate",
      arguments: { id: e, reason: "Moving off Aurora." },
    });
    expect(structured(deprecate)).toMatchObject({ command: "deprecate", ok: true });
    const illegal = await client.callTool({
      name: "adr_deprecate",
      arguments: { id: a, reason: "x" },
    });
    expect(rules(illegal)).toEqual(["transition/illegal"]);
    const unaccepted = await client.callTool({
      name: "adr_supersede",
      arguments: { id: e, by: c },
    });
    expect(rules(unaccepted)).toContain("decision/superseded-by-unaccepted");
  });

  it("withdraws another person's proposal with mcp_can_decide", async () => {
    const r = await repo({ "adr.toml": DECIDE });
    const { b, c } = await fixture(r);
    const { client } = await connect(r);
    const others = await client.callTool({ name: "adr_withdraw", arguments: { id: c } });
    expect(structured(others)).toMatchObject({
      command: "withdraw",
      ok: true,
      decision: { status: "withdrawn" },
    });
    const accepted = await client.callTool({ name: "adr_withdraw", arguments: { id: b } });
    expect(rules(accepted)).toEqual(["transition/illegal"]);
  });

  it("tells the user to restart when mcp_can_decide was turned off", async () => {
    const r = await repo({ "adr.toml": DECIDE });
    const { c } = await fixture(r);
    const { client } = await connect(r);
    await writeFile(join(r.root, "adr.toml"), "[policy]\nmcp_can_decide = false\n");
    const call = await client.callTool({ name: "adr_reject", arguments: { id: c, reason: "x" } });
    expect(call.isError).toBe(true);
    expect(structured(call)).toMatchObject({
      error: {
        code: "usage",
        message:
          "[policy] mcp_can_decide is now false in adr.toml; restart adr mcp to update its tool list",
      },
    });
  });
});
