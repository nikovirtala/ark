import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

// The built entry, served over real stdio by a child process, as `<tool> mcp` does.
const MCP = new URL("../../dist/mcp.js", import.meta.url);
if (!existsSync(MCP)) throw new Error("dist/mcp.js is missing; run `pnpm build` first");

const CHILD = `
const { serveMcp } = await import(process.env.MCP_URL);
process.on("exit", (code) => process.stderr.write("exited " + code + "\\n"));
await serveMcp({
  name: "t",
  version: "1.0.0",
  tools: [{
    name: "t_ping",
    description: "Ping.",
    inputSchema: { type: "object", additionalProperties: false },
    run: async (_, ctx) => ({ document: { client: ctx.client }, headers: [], text: "pong" }),
  }],
});
`;

it("serves over stdio and exits 0 soon after the client closes", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", CHILD],
    env: { PATH: process.env.PATH ?? "", MCP_URL: MCP.href },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(transport);
  const r = await client.callTool({ name: "t_ping", arguments: {} });
  expect(r.structuredContent).toEqual({ client: { name: "stdio-test", version: "1" } });
  const t0 = Date.now();
  await client.close();
  await expect.poll(() => stderr, { timeout: 2000 }).toContain("exited 0");
  expect(Date.now() - t0).toBeLessThan(2000);
});
