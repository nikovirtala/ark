import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openIssueLog, readIssues } from "../log.js";
import { renderIssueIndexText } from "../log-index.js";
import { newIssue } from "../test-support/cli.js";
import { connectMcp, type McpIssues, mcpError, mcpRepo } from "../test-support/mcp.js";
import { readyIssues } from "../views.js";

const repos: TempRepo[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closes.splice(0)) await c();
  for (const r of repos.splice(0)) await r.dispose();
});

async function setup(
  files: Record<string, string> = {},
): Promise<{ r: TempRepo; ids: McpIssues; client: Client }> {
  const s = await mcpRepo(files);
  repos.push(s.r);
  const c = await connectMcp(s.r);
  closes.push(c.close);
  return { ...s, client: c.client };
}

const read = async (r: TempRepo) =>
  readIssues(await openIssueLog({ cwd: r.root, gitOptions: { env: r.env } }));

const contents = async (client: Client, uri: string) => {
  const r = await client.readResource({ uri });
  return r.contents[0] as { uri: string; mimeType: string; text: string };
};

describe("issues mcp resources", { timeout: 60_000 }, () => {
  it("lists the index and the ready list, and the issue template", async () => {
    const { client } = await setup();
    expect((await client.listResources()).resources.map((x) => [x.uri, x.mimeType])).toEqual([
      ["issues://index", "text/markdown"],
      ["issues://ready", "text/markdown"],
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: "issues://issue/{id}", mimeType: "text/markdown" }),
    ]);
  });

  it.each([{}, { "docs/issues/issues.toml": '[log]\nindex = "committed"\n' }])(
    "serves the index as renderIssueIndexText renders it (%j)",
    async (files) => {
      const { r, client } = await setup(files);
      const c = await contents(client, "issues://index");
      expect(c).toEqual({
        uri: "issues://index",
        mimeType: "text/markdown",
        text: renderIssueIndexText(await read(r)),
      });
      expect(c.text).toContain("## In progress");
      // With a committed index, the resource is the table index.md holds.
      const file = await readFile(join(r.root, "docs/issues/index.md"), "utf8").catch(() => null);
      if ("docs/issues/issues.toml" in files) expect(c.text).toBe(file);
      else expect(file).toBeNull();
      expect(c.text).toMatch(/\| \?1 \| \[Login fails on Safari\]/);
    },
  );

  it("serves the ready list in readyIssues' order", async () => {
    const { r, ids, client } = await setup();
    const f = newIssue(r, "Write the docs", ["--label", "docs"]);
    const order = readyIssues(await read(r)).issues.map((v) => v.id);
    expect(order).toEqual([ids.e, f]);
    expect((await contents(client, "issues://ready")).text).toBe(
      `# Ready issues\n\n- ?5 (${ids.e}) Add dark mode [type:feature]\n- ?6 (${f}) Write the docs [docs]\n`,
    );
  });

  it("serves an issue by id, number and %3F number, header first", async () => {
    const { ids, client } = await setup();
    const texts: string[] = [];
    for (const id of [ids.b, "2", "0002", "%3F2"]) {
      const c = await contents(client, `issues://issue/${id}`);
      expect(c.uri).toBe(`issues://issue/${id}`);
      texts.push(c.text);
    }
    expect(new Set(texts).size).toBe(1);
    expect((texts[0] ?? "").split("\n").slice(0, 4)).toEqual([
      `?2 (${ids.b}) · closed`,
      "DUPLICATE of ?1 (in-progress). Track work on ?1; read issues://issue/1.",
      "",
      "# Safari login loops",
    ]);
    const blocked = await contents(client, "issues://issue/3");
    expect(blocked.text.split("\n").slice(0, 2)).toEqual([
      `?3 (${ids.c}) · open`,
      "BLOCKED by ?1 (in-progress). Finish them first.",
    ]);
  });

  it("answers unknown, malformed and qualified ids with JSON-RPC errors", async () => {
    const { client } = await setup();
    const cases: [string, number, string][] = [
      ["issues://issue/?2", -32002, "resource not found: issues://issue/?2"],
      ["issues://issue/zzzzzzzz", -32002, "resource not found: issues://issue/zzzzzzzz"],
      ["issues://issue/99", -32002, "resource not found"],
      ["issues://nothing", -32002, "resource not found"],
      ["issues://issue/a%3Ab", -32602, "is in another log"],
      [`issues://issue/${"x".repeat(65)}`, -32602, "at most 64 characters"],
      ["issues://issue/%ZZ", -32602, "malformed resource URI"],
    ];
    for (const [uri, code, message] of cases) {
      const err = await mcpError(client.readResource({ uri }));
      expect(err.code, uri).toBe(code);
      expect(err.message, uri).toContain(message);
    }
  });
});
