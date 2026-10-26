import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { renderIndex } from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDecisionLog, readDecisions } from "../log.js";
import { DECISION_INDEX } from "../log-index.js";
import { cliRepo, seedDecision, seedSupersession } from "../test-support/cli.js";
import { serveAdrMcp } from "./server.js";

const repos: TempRepo[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closes.splice(0)) await c();
  for (const r of repos.splice(0)) await r.dispose();
});

async function setup(files: Record<string, string> = {}) {
  const r = await cliRepo(files);
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
  const client = new Client({ name: "resources-test", version: "1" });
  await client.connect(clientSide);
  closes.push(async () => {
    await client.close();
    await served;
  });
  return { r, a, b, client };
}

const contents = async (client: Client, uri: string) => {
  const r = await client.readResource({ uri });
  return (r.contents[0] as { uri: string; mimeType: string; text: string }) ?? null;
};

async function mcpError(p: Promise<unknown>): Promise<McpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpError);
  return err as McpError;
}

describe("adr mcp resources", { timeout: 60_000 }, () => {
  it("lists the index and the decision template", async () => {
    const { client } = await setup();
    expect((await client.listResources()).resources.map((x) => x.uri)).toEqual(["adr://index"]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: "adr://decision/{id}", mimeType: "text/markdown" }),
    ]);
  });

  it.each([{}, { "adr.toml": '[log]\nindex = "committed"\n' }])(
    "serves the index as adr index renders it (%j)",
    async (files) => {
      const { r, client } = await setup(files);
      const read = await readDecisions(
        await openDecisionLog({ cwd: r.root, gitOptions: { env: r.env } }),
      );
      const views = read.projection.views;
      const c = await contents(client, "adr://index");
      expect(c).toEqual({
        uri: "adr://index",
        mimeType: "text/markdown",
        text: renderIndex(DECISION_INDEX(read.root, views), [...views.values()], read.numbering),
      });
      expect(c?.text).toContain("| ADR-0002 |");
    },
  );

  it("serves a decision by id, number and ADR-NNNN, header first", async () => {
    const { a, client } = await setup();
    const texts = [];
    for (const id of [a, "1", "0001", "ADR-0001", "adr-1"]) {
      const c = await contents(client, `adr://decision/${id}`);
      expect(c?.uri).toBe(`adr://decision/${id}`);
      texts.push(c?.text);
    }
    expect(new Set(texts).size).toBe(1);
    const lines = (texts[0] ?? "").split("\n");
    expect(lines[0]).toBe(`ADR-0001 (${a}) · superseded`);
    expect(lines[1]).toMatch(/read adr:\/\/decision\/ADR-0002 instead\.$/);
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("# Use DynamoDB for orders");
  });

  it.each<[string, number, string]>([
    ["adr://decision/zzzzzzzz", -32002, "resource not found: adr://decision/zzzzzzzz"],
    ["adr://decision/99", -32002, "resource not found"],
    ["adr://nothing", -32002, "resource not found"],
    ["adr://decision/a%3Ab", -32602, "is in another log"],
    [`adr://decision/${"x".repeat(65)}`, -32602, "at most 64 characters"],
    ["adr://decision/%ZZ", -32602, "malformed resource URI"],
  ])("answers %s with %d", async (uri, code, message) => {
    const { client } = await setup();
    const err = await mcpError(client.readResource({ uri }));
    expect(err.code).toBe(code);
    expect(err.message).toContain(message);
  });
});
