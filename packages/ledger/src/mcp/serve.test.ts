import { execFileSync } from "node:child_process";
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
import {
  currentGitOperation,
  type GitOperation,
  liveResidentCount,
  withGitOperation,
} from "../git/operation.js";
import { createTempRepo } from "../testing/temp-repo.js";
import { serveMcp } from "./serve.js";
import type {
  McpPrompt,
  McpResource,
  McpResourceTemplate,
  McpServerSpec,
  McpTool,
} from "./types.js";

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

const index: McpResource = {
  uri: "t://index",
  name: "index",
  description: "All items.",
  mimeType: "text/markdown",
  read: async () => ({ header: null, text: "# Index\n" }),
};

const item: McpResourceTemplate = {
  uriTemplate: "t://item/{id}",
  name: "item",
  title: "Item",
  description: "One item.",
  mimeType: "text/markdown",
  read: async ({ id }) => {
    if (id === "gone") return null;
    if (id === "bad") throw new UsageError("invalid item bad");
    if (id === "cfg") throw new ConfigError("bad config");
    if (id === "bug") throw new Error("oops");
    return {
      header: { line: `T-1 (${id}) · superseded`, warning: "Read t://item/T-2." },
      text: "body\n",
    };
  },
};

const prompt: McpPrompt = {
  name: "t_draft",
  title: "Draft",
  description: "Drafts something.",
  arguments: [
    { name: "title", description: "The title", required: true },
    { name: "note", description: "A note", required: false },
  ],
  get: async (args) => {
    if (args.title === "bad") throw new UsageError("unknown template bad");
    return `Draft ${args.title}${args.note === undefined ? "" : ` (${args.note})`}.`;
  },
};

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
    ["a prompt without the prefix", { prompts: [{ ...prompt, name: "draft" }] }],
    ["a prompt named like a tool", { tools: [echo], prompts: [{ ...prompt, name: "t_echo" }] }],
    ["a duplicate resource", { resources: [index, index] }],
    [
      "a bad resource template",
      { resourceTemplates: [{ ...item, uriTemplate: "t://item/x{id}" }] },
    ],
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

describe("serveMcp resources", () => {
  it("advertises resources and prompts only when the spec has them", async () => {
    const { client } = await connect({ tools: [echo] });
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    const both = await connect({ resources: [index], prompts: [prompt] });
    expect(both.client.getServerCapabilities()).toEqual({ tools: {}, resources: {}, prompts: {} });
  });

  it("lists resources and templates", async () => {
    const { client } = await connect({ resources: [index], resourceTemplates: [item] });
    expect((await client.listResources()).resources).toEqual([
      { uri: "t://index", name: "index", description: "All items.", mimeType: "text/markdown" },
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([
      {
        uriTemplate: "t://item/{id}",
        name: "item",
        title: "Item",
        description: "One item.",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("reads an exact URI and a template match, header first", async () => {
    const { client } = await connect({ resources: [index], resourceTemplates: [item] });
    expect(await client.readResource({ uri: "t://index" })).toEqual({
      contents: [{ uri: "t://index", mimeType: "text/markdown", text: "# Index\n" }],
    });
    expect(await client.readResource({ uri: "t://item/a%20b" })).toEqual({
      contents: [
        {
          uri: "t://item/a%20b",
          mimeType: "text/markdown",
          text: "T-1 (a b) · superseded\nRead t://item/T-2.\n\nbody\n",
        },
      ],
    });
  });

  it.each<[string, number, string]>([
    ["t://item/gone", -32002, "resource not found: t://item/gone"],
    ["t://other", -32002, "resource not found: t://other"],
    ["t://item/bad", -32602, "invalid item bad"],
    ["t://item/%E0%A4%A", -32602, "malformed resource URI"],
    ["t://item/cfg", -32603, "config: bad config"],
    ["t://item/bug", -32603, "internal error: oops"],
  ])("answers %s with %d", async (uri, code, message) => {
    const { client, stderr } = await connect({ resources: [index], resourceTemplates: [item] });
    const err = await mcpError(client.readResource({ uri }));
    expect(err.code).toBe(code);
    expect(err.message).toContain(message);
    expect(stderr.join("") !== "").toBe(uri === "t://item/bug");
  });
});

describe("serveMcp prompts", () => {
  it("lists prompts and returns one user message", async () => {
    const { client } = await connect({ prompts: [prompt] });
    expect((await client.listPrompts()).prompts).toEqual([
      {
        name: "t_draft",
        title: "Draft",
        description: "Drafts something.",
        arguments: prompt.arguments,
      },
    ]);
    expect(
      await client.getPrompt({ name: "t_draft", arguments: { title: "X", note: "n" } }),
    ).toEqual({
      description: "Drafts something.",
      messages: [{ role: "user", content: { type: "text", text: "Draft X (n)." } }],
    });
  });

  it.each<[string, string, Record<string, string>, string]>([
    ["an unknown prompt", "t_nope", { title: "X" }, "unknown prompt t_nope"],
    ["an undeclared argument", "t_draft", { title: "X", other: "y" }, "unknown argument other"],
    ["a missing required argument", "t_draft", {}, "missing argument title"],
    ["a long argument", "t_draft", { title: "x".repeat(1001) }, "longer than 1000 characters"],
    ["a NUL", "t_draft", { title: "a\0b" }, "contains a NUL character"],
    ["a usage error from get", "t_draft", { title: "bad" }, "unknown template bad"],
  ])("answers %s with -32602", async (_, name, args, message) => {
    const { client } = await connect({ prompts: [prompt] });
    const err = await mcpError(client.getPrompt({ name, arguments: args }));
    expect(err.code).toBe(-32602);
    expect(err.message).toContain(message);
  });
});

describe("serveMcp git operations", () => {
  // `issues mcp` and `adr mcp` run the server inside runCli's git operation. The client calls
  // are made inside that operation too, because InMemoryTransport hands messages over
  // synchronously, so the handlers run in the sender's async context, as stdio requests do
  // under runCli. A server whose requests joined the outer operation would fail here.
  it("runs each request in its own operation and retires the outer one's residents", async () => {
    const r = await createTempRepo({ files: { "a.txt": "a\n" } });
    open.push(() => r.dispose());
    await r.git.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await r.git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const seen: { op: GitOperation | null; outerResidents: number | undefined }[] = [];
    let outer = null as GitOperation | null;
    const head: McpTool = {
      name: "t_head",
      description: "Returns origin/HEAD's target.",
      inputSchema: { type: "object", additionalProperties: false },
      run: async () => {
        seen.push({ op: currentGitOperation(), outerResidents: outer?.residentCount });
        const target = await r.git.symbolicRef("refs/remotes/origin/HEAD");
        return { document: { target }, headers: [], text: String(target) };
      },
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...r.env })) {
      if (v !== undefined) env[k] = v;
    }
    const targets: unknown[] = [];
    await withGitOperation(async () => {
      outer = currentGitOperation();
      await r.git.resolveCommit("HEAD"); // the outer operation now holds a resident
      expect(liveResidentCount()).toBe(1);
      expect(outer?.residentCount).toBe(1);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const served = serveMcp(
        { name: "t", version: "1.2.3", tools: [head] },
        { transport: serverSide },
      );
      const client = new Client({ name: "test-client", version: "9.9.9" });
      await client.connect(clientSide);
      const call = () => client.callTool({ name: "t_head", arguments: {} });
      targets.push((await call()).structuredContent);
      // Outside any operation, as a user's terminal would.
      execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/x"], {
        cwd: r.root,
        env,
      });
      targets.push((await call()).structuredContent);
      await client.close();
      await served;
    });
    expect(targets).toEqual([
      { target: "refs/remotes/origin/main" },
      { target: "refs/remotes/origin/x" },
    ]);
    expect(seen).toHaveLength(2);
    const [a, b] = seen;
    expect(a?.op).not.toBeNull();
    expect(b?.op).not.toBeNull();
    expect(a?.op).not.toBe(outer);
    expect(b?.op).not.toBe(outer);
    expect(a?.op).not.toBe(b?.op);
    // serveMcp's invalidateGitOperation() on entry retired the outer operation's resident.
    expect(seen.map((s) => s.outerResidents)).toEqual([0, 0]);
    expect(liveResidentCount()).toBe(0);
  });
});
