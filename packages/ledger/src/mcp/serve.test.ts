import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommitFailedError,
  ConfigError,
  InvalidArgumentError,
  type JsonValue,
  UsageError,
} from "../errors.js";
import { serveMcp } from "./serve.js";
import type { McpServerSpec, McpTool } from "./types.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const echo: McpTool = {
  name: "t_echo",
  title: "Echo",
  description: "Returns its input.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 }, n: { type: "integer" } },
    required: ["text"],
    additionalProperties: false,
  },
  inputHint: "t_echo needs text",
  annotations: { readOnlyHint: true },
  run: async (input) => ({
    document: { format: "t-echo/v1", input },
    headers: [
      { line: "T-1 (abc) · superseded", warning: "SUPERSEDED by T-2." },
      { line: "T-2 (def) · accepted", warning: null },
    ],
    text: `echo ${String(input.text)}`,
  }),
};

const thrower = (name: string, err: unknown): McpTool => ({
  name,
  description: "Throws.",
  inputSchema: { type: "object", additionalProperties: false },
  run: async () => {
    throw err;
  },
});

async function connect(
  spec: Partial<McpServerSpec>,
  o: { readonly clientName?: string } = {},
): Promise<{ client: Client; stderr: string[]; served: Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const stderr: string[] = [];
  const served = serveMcp(
    { name: "t", version: "1.2.3", tools: [], ...spec },
    { transport: serverSide, env: { A: "1" }, stderr: { write: (s) => void stderr.push(s) } },
  );
  const client = new Client({ name: o.clientName ?? "test-client", version: "9.9.9" });
  await client.connect(clientSide);
  open.push(async () => {
    await client.close();
    await served;
  });
  return { client, stderr, served };
}

const texts = (r: unknown) =>
  (r as { content: { type: string; text: string }[] }).content.map((c) => c.text);

async function mcpError(p: Promise<unknown>): Promise<McpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpError);
  return err as McpError;
}

describe("serveMcp spec checks", () => {
  const bad = async (spec: Partial<McpServerSpec>) =>
    serveMcp(
      { name: "t", version: "1", tools: [], ...spec },
      { transport: InMemoryTransport.createLinkedPair()[1] },
    );

  it.each<[string, Partial<McpServerSpec>]>([
    ["a bad server name", { name: "T!" }],
    ["a tool without the prefix", { tools: [{ ...echo, name: "echo" }] }],
    ["a tool with bad characters", { tools: [{ ...echo, name: "t_Echo" }] }],
    ["a duplicate tool", { tools: [echo, echo] }],
    ["a tool also unavailable", { tools: [echo], unavailable: { t_echo: "no" } }],
    ["an unavailable tool without the prefix", { unavailable: { echo: "no" } }],
    [
      "a schema that doesn't compile",
      { tools: [{ ...echo, inputSchema: { type: "object", nope: 1 } }] },
    ],
    ["a schema that isn't an object", { tools: [{ ...echo, inputSchema: { type: "string" } }] }],
    ["an inputHint over two lines", { tools: [{ ...echo, inputHint: "a\nb" }] }],
  ])("rejects %s", async (_, spec) => {
    await expect(bad(spec)).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it("maps hyphens in the server name to underscores in the prefix", async () => {
    await expect(bad({ name: "my-tool", tools: [{ ...echo, name: "my-tool_x" }] })).rejects.toThrow(
      InvalidArgumentError,
    );
    const { client } = await connect({ name: "my-tool", tools: [{ ...echo, name: "my_tool_x" }] });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["my_tool_x"]);
  });
});

describe("serveMcp tools", () => {
  it("lists tools in spec order with their fields, and sends the instructions", async () => {
    const { client } = await connect({ tools: [echo, thrower("t_boom", 1)], instructions: "Hi." });
    expect((await client.listTools()).tools).toEqual([
      {
        name: "t_echo",
        title: "Echo",
        description: "Returns its input.",
        inputSchema: echo.inputSchema,
        annotations: { readOnlyHint: true },
      },
      {
        name: "t_boom",
        description: "Throws.",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ]);
    expect(client.getInstructions()).toBe("Hi.");
  });

  it("returns the document as structuredContent, headers first in the text", async () => {
    const { client } = await connect({ tools: [echo] });
    const r = await client.callTool({ name: "t_echo", arguments: { text: "hi" } });
    const doc = { format: "t-echo/v1", input: { text: "hi" } };
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual(doc);
    const [text, json] = texts(r);
    expect(text).toBe(
      "T-1 (abc) · superseded\nSUPERSEDED by T-2.\nT-2 (def) · accepted\n\necho hi",
    );
    expect(JSON.parse(json ?? "")).toEqual(doc);
  });

  it("omits the blank line without headers", async () => {
    const plain: McpTool = { ...echo, run: async () => ({ document: {}, headers: [], text: "x" }) };
    const { client } = await connect({ tools: [plain] });
    expect(texts(await client.callTool({ name: "t_echo", arguments: { text: "a" } }))[0]).toBe("x");
  });

  it("reports invalid input as a usage error with at most five problems and the hint", async () => {
    const { client } = await connect({ tools: [echo] });
    const r = await client.callTool({
      name: "t_echo",
      arguments: { n: "x", a: 1, b: 2, c: 3, d: 4, e: 5 },
    });
    expect(r.isError).toBe(true);
    const doc = r.structuredContent as { format: string; error: { code: string; message: string } };
    expect(doc.format).toBe("ark-error/v1");
    expect(doc.error.code).toBe("usage");
    expect(doc.error.message).toMatch(
      /^invalid input for t_echo: \/ must have required property 'text'; /,
    );
    expect(doc.error.message.split("; ")).toHaveLength(6);
    expect(doc.error.message).toMatch(/; and \d+ more\. t_echo needs text$/);
    expect(texts(r)[0]).toBe(`usage: ${doc.error.message}`);
  });

  it("treats missing arguments as {}", async () => {
    const { client } = await connect({ tools: [echo] });
    const r = await client.callTool({ name: "t_echo" });
    expect((r.structuredContent as { error: { message: string } }).error.message).toBe(
      "invalid input for t_echo: / must have required property 'text'. t_echo needs text",
    );
  });

  it("maps ledger errors to their codes and anything else to internal", async () => {
    const recovery = { staged: ["a"], messageFile: "/m", command: "git commit", trailers: [] };
    const failed = new CommitFailedError({
      recovery,
      headline: "git commit failed",
      detail: "",
      rerun: "Don't.",
      before: null,
      after: null,
      notes: ["index refreshed"],
    });
    const { client, stderr } = await connect({
      tools: [
        thrower("t_usage", new UsageError("bad id")),
        thrower("t_config", new ConfigError("bad config")),
        thrower("t_commit", failed),
        thrower("t_bug", new Error("oops")),
      ],
    });
    const call = async (name: string) => {
      const r = await client.callTool({ name, arguments: {} });
      expect(r.isError).toBe(true);
      expect(JSON.parse(texts(r)[1] ?? "")).toEqual(r.structuredContent);
      return r.structuredContent;
    };
    expect(await call("t_usage")).toEqual({
      format: "ark-error/v1",
      error: { code: "usage", message: "bad id" },
    });
    expect(await call("t_config")).toMatchObject({ error: { code: "config" } });
    expect(await call("t_commit")).toMatchObject({
      error: { code: "commit-failed" },
      notes: ["index refreshed"],
    });
    expect(stderr).toEqual([]);
    expect(await call("t_bug")).toEqual({
      format: "ark-error/v1",
      error: { code: "internal", message: "oops" },
    });
    expect(stderr.join("")).toMatch(/^t: internal error: oops\nError: oops\n\s+at /);
  });

  it("reports a non-object document as internal", async () => {
    const bad: McpTool = { ...echo, run: async () => ({ document: [1], headers: [], text: "" }) };
    const { client, stderr } = await connect({ tools: [bad] });
    const r = await client.callTool({ name: "t_echo", arguments: { text: "a" } });
    expect(r.structuredContent).toMatchObject({
      error: { code: "internal", message: "tool t_echo returned a non-object document" },
    });
    expect(stderr.join("")).toContain("TypeError");
  });

  it("answers unknown and unavailable tools with -32602", async () => {
    const { client } = await connect({ tools: [echo], unavailable: { t_decide: "ask a human" } });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["t_echo"]);
    const unknown = await mcpError(client.callTool({ name: "t_nope", arguments: {} }));
    expect(unknown.code).toBe(-32602);
    expect(unknown.message).toContain("unknown tool t_nope");
    const off = await mcpError(client.callTool({ name: "t_decide", arguments: {} }));
    expect(off.code).toBe(-32602);
    expect(off.message).toContain("t_decide is not available: ask a human");
  });

  it("runs calls one at a time, in arrival order", async () => {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const gated: McpTool = {
      ...echo,
      run: async (input) => {
        const id = String(input.text);
        log.push(`start ${id}`);
        await new Promise<void>((resolve) => gates.set(id, resolve));
        log.push(`end ${id}`);
        return { document: { id } as JsonValue, headers: [], text: id };
      },
    };
    const { client } = await connect({ tools: [gated] });
    const a = client.callTool({ name: "t_echo", arguments: { text: "a" } });
    const b = client.callTool({ name: "t_echo", arguments: { text: "b" } });
    await expect.poll(() => gates.has("a")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(gates.has("b")).toBe(false);
    gates.get("a")?.();
    await expect.poll(() => gates.has("b")).toBe(true);
    gates.get("b")?.();
    await Promise.all([a, b]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("passes the client's name and the server env to tools", async () => {
    let seen: unknown = null;
    const spy: McpTool = {
      ...echo,
      run: async (_, ctx) => {
        seen = ctx;
        return { document: {}, headers: [], text: "" };
      },
    };
    const { client } = await connect({ tools: [spy] }, { clientName: "Claude Code" });
    await client.callTool({ name: "t_echo", arguments: { text: "a" } });
    expect(seen).toEqual({ client: { name: "Claude Code", version: "9.9.9" }, env: { A: "1" } });
  });

  it("resolves when the client closes", async () => {
    const { client, served } = await connect({ tools: [echo] });
    open.length = 0;
    await client.close();
    await expect(served).resolves.toBeUndefined();
  });
});
