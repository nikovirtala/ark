import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, seedDecision, seedSupersession } from "../test-support/cli.js";
import { serveAdrMcp } from "./server.js";

const repos: TempRepo[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closes.splice(0)) await c();
  for (const r of repos.splice(0)) await r.dispose();
});

async function setup() {
  const r = await cliRepo();
  repos.push(r);
  const a = await seedDecision(r, "Use DynamoDB for orders");
  const b = await seedDecision(r, "Use Aurora for orders");
  await seedSupersession(r, a, b);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = serveAdrMcp({
    cwd: r.root,
    root: null,
    env: { ...r.env, ARK_ON_BEHALF_OF: "niko@example.com" },
    version: "0.0.0-test",
    stderr: { write: () => {} },
    transport: serverSide,
  });
  const client = new Client({ name: "prompt-test", version: "1" });
  await client.connect(clientSide);
  closes.push(async () => {
    await client.close();
    await served;
  });
  return { b, client };
}

const textOf = async (client: Client, args: Record<string, string>) => {
  const r = await client.getPrompt({ name: "adr_draft_from_discussion", arguments: args });
  expect(r.messages).toHaveLength(1);
  expect(r.messages[0]?.role).toBe("user");
  return (r.messages[0]?.content as { text?: string } | undefined)?.text ?? "";
};

describe("adr_draft_from_discussion", { timeout: 60_000 }, () => {
  it("is listed with three optional arguments", async () => {
    const { client } = await setup();
    const [p] = (await client.listPrompts()).prompts;
    expect(p?.name).toBe("adr_draft_from_discussion");
    expect(p?.arguments?.map((a) => [a.name, a.required])).toEqual([
      ["title", false],
      ["template", false],
      ["supersedes", false],
    ]);
  });

  it("names the default template's sections, without the optional lines", async () => {
    const { client } = await setup();
    const lines = (await textOf(client, {})).split("\n");
    expect(lines[0]).toBe(
      "Turn the current discussion into an architecture decision proposal with adr.",
    );
    expect(lines.some((l) => l.startsWith("1a."))).toBe(false);
    expect(lines).toContain("2. Use the template nygard (version 1). Its sections:");
    expect(lines).toContain(
      "   - context: Context, required. What is the issue that motivates this decision? Describe the forces at play.",
    );
    expect(lines).toContain(
      '4. Call adr_propose with the title a short title that states the decision, such as "Use PostgreSQL for orders", template "nygard", the sections map.',
    );
    expect(lines).toContain(
      "5. If the result has ok: true with findings, fix those sections with adr_update_draft and the new decision's id. If it was refused (ok: false), fill in every section the findings name and call adr_propose again.",
    );
    expect(lines.at(-1)).toBe(
      "6. Don't accept the proposal. Tell the user its id, and that they can review it and run: adr accept <id>",
    );
  });

  it("fills in the title, template and superseded decision", async () => {
    const { b, client } = await setup();
    const text = await textOf(client, {
      title: "Cache order reads",
      template: "madr",
      supersedes: "2",
    });
    expect(text).toContain(
      `1a. The user named ADR-0002 (${b}) as the decision this replaces; read it with adr_get first.`,
    );
    expect(text).toContain("2. Use the template madr (version 1). Its sections:");
    expect(text).toContain(
      `4. Call adr_propose with the title "Cache order reads", template "madr", the sections map, and supersedes ["${b}"].`,
    );
  });

  it.each([
    [{ template: "nope" }, "unknown template nope; adr_templates lists them"],
    [{ supersedes: "zzzzzzzz" }, "unknown decision zzzzzzzz"],
  ])("refuses %j with -32602", async (args, message) => {
    const { client } = await setup();
    const err = await client
      .getPrompt({ name: "adr_draft_from_discussion", arguments: args })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(-32602);
    expect((err as McpError).message).toContain(message);
  });
});
