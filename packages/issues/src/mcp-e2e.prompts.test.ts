/**
 * End to end, the prompts session: the BUILT `issues mcp`, spawned over real stdio and driven by
 * the MCP SDK's client, in a temp git repository set up with the CLI (design §8.6). The helpers
 * are in `test-support/mcp-stdio.ts`. Session P1 lists both prompts and gets each with arguments.
 */
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpIssues, ME, mcpError, mcpRepo } from "./test-support/mcp.js";
import { startMcp, TIMEOUT } from "./test-support/mcp-stdio.js";

describe("issues mcp prompts over stdio (built)", () => {
  let r: TempRepo;
  let ids: McpIssues;

  beforeAll(async () => {
    ({ r, ids } = await mcpRepo());
  }, TIMEOUT);

  afterAll(async () => {
    await r?.dispose();
  });

  it(
    "session P1: lists both prompts and gets each with arguments",
    async () => {
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const textOf = async (name: string, args: Record<string, string>) => {
        const res = await s.client.getPrompt({ name, arguments: args });
        expect(res.messages.map((m) => m.role)).toEqual(["user"]);
        return (res.messages[0]?.content as { text?: string } | undefined)?.text ?? "";
      };

      // 1. Both prompts, with their arguments.
      expect(
        (await s.client.listPrompts()).prompts.map((p) => [
          p.name,
          p.arguments?.map((a) => [a.name, a.required]),
        ]),
      ).toEqual([
        [
          "issues_from_discussion",
          [
            ["title", false],
            ["template", false],
            ["parent", false],
          ],
        ],
        [
          "issues_breakdown",
          [
            ["id", true],
            ["template", false],
          ],
        ],
      ]);

      // 2. The template's sections, the parent and the title.
      const discussion = await textOf("issues_from_discussion", {
        title: "Fix the session cookie",
        template: "bug",
        parent: "1",
      });
      expect(discussion).toContain(
        `1a. The new issue is part of ?1 (${ids.a}); read it with issues_get first.`,
      );
      expect(discussion).toContain("2. Use the template bug (version 1). Its sections:");
      expect(discussion).toContain(
        "   - summary: Summary, required. One or two sentences on what is wrong, for whom.",
      );
      expect(discussion).toContain(
        `the title "Fix the session cookie", template "bug", the sections map, and parent "${ids.a}".`,
      );

      // 3. The issue's header line and its children.
      const breakdown = (await textOf("issues_breakdown", { id: "1", template: "task" })).split(
        "\n",
      );
      expect(breakdown[2]).toBe(`?1 (${ids.a}) · in-progress`);
      expect(breakdown.join("\n")).toContain("Its children so far: none.");
      expect(breakdown.join("\n")).toContain(`template "task", parent "${ids.a}"`);

      // 4. An unknown issue is invalid params.
      const err = await mcpError(
        s.client.getPrompt({ name: "issues_breakdown", arguments: { id: "999" } }),
      );
      expect(err.code).toBe(-32602);
      expect(err.message).toContain("unknown issue 999");

      // 5. The session ends cleanly.
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe("");
    },
    TIMEOUT,
  );
});
