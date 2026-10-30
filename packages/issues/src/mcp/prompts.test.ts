import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, mcpError, type WriteIssues, writeRepo } from "../test-support/mcp.js";

// Prompts only read, so every case shares one repository and one client.
let r: TempRepo;
let ids: WriteIssues;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ r, ids } = await writeRepo());
  ({ client, close } = await connectMcp(r));
}, 120_000);

afterAll(async () => {
  await close?.();
  await r?.dispose();
});

const lines = async (name: string, args: Record<string, string>) => {
  const res = await client.getPrompt({ name, arguments: args });
  expect(res.messages).toHaveLength(1);
  expect(res.messages[0]?.role).toBe("user");
  return ((res.messages[0]?.content as { text?: string } | undefined)?.text ?? "").split("\n");
};

const TASK_SECTIONS = [
  "2. Use the template task (version 1). Its sections:",
  "   - goal: Goal, required. What this task changes, in a sentence or two.",
  "   - notes: Notes, optional. Context, links and anything the person doing it should know.",
  "   - done: Done when, required. Observable conditions that make this issue finished.",
];

describe("issues mcp prompts", { timeout: 60_000 }, () => {
  it("lists issues_from_discussion and issues_breakdown with their arguments", async () => {
    const { prompts } = await client.listPrompts();
    expect(
      prompts.map((p) => [p.name, p.title, p.arguments?.map((a) => [a.name, a.required])]),
    ).toEqual([
      [
        "issues_from_discussion",
        "Open an issue from the discussion",
        [
          ["title", false],
          ["template", false],
          ["parent", false],
        ],
      ],
      [
        "issues_breakdown",
        "Break an issue down",
        [
          ["id", true],
          ["template", false],
        ],
      ],
    ]);
    expect(prompts[0]?.description).toBe(
      "Turn the current conversation into one issue, filling the template's sections and listing open questions, after checking for an existing issue.",
    );
    expect(prompts[1]?.description).toBe(
      "Split a large issue into child issues linked with part-of, with depends-on between them where order matters.",
    );
  });

  it("issues_from_discussion names the default template's sections and the title hint", async () => {
    const l = await lines("issues_from_discussion", {});
    expect(l[0]).toBe("Turn the current discussion into one issue with issues.");
    expect(l.some((x) => x.startsWith("1a."))).toBe(false);
    const at = l.indexOf(TASK_SECTIONS[0] ?? "");
    expect(l.slice(at, at + TASK_SECTIONS.length)).toEqual(TASK_SECTIONS);
    expect(l).toContain(
      "3. Fill every required section with facts from the discussion and the code only. Write Done when as conditions someone else can check. List what wasn't settled as open questions in the Notes section instead of inventing answers.",
    );
    expect(l).toContain(
      '4. Call issues_open with the title a short imperative title, such as "Fix the session cookie on Safari", template "task", the sections map. Add labels only when the discussion names them.',
    );
    expect(l.at(-1)).toBe(
      "6. Tell the user the new issue's number or id, and its open questions. Don't start it unless the user asks.",
    );
  });

  it("issues_from_discussion fills in the title, template and parent", async () => {
    const l = await lines("issues_from_discussion", {
      title: "Fix the session cookie",
      template: "bug",
      parent: "1",
    });
    expect(l).toContain(
      `1a. The new issue is part of ?1 (${ids.a}); read it with issues_get first.`,
    );
    expect(l).toContain("2. Use the template bug (version 1). Its sections:");
    expect(l).toContain(
      "   - reproduce: Steps to reproduce, required. Numbered steps from a clean state. Include versions.",
    );
    // bug has no notes section and no optional one, so open questions go in its first section.
    expect(l.find((x) => x.startsWith("3. "))).toContain("open questions in the Summary section");
    expect(l).toContain(
      `4. Call issues_open with the title "Fix the session cookie", template "bug", the sections map, and parent "${ids.a}". Add labels only when the discussion names them.`,
    );
  });

  it("issues_breakdown shows the header and the children so far", async () => {
    const l = await lines("issues_breakdown", { id: "7" });
    expect(l.slice(0, 4)).toEqual([
      `Break ?7 (${ids.g}) down into child issues with issues.`,
      "",
      `?7 (${ids.g}) · open`,
      "",
    ]);
    expect(l[4]).toBe(
      `1. Read ?7 (${ids.g}) with issues_get. If its header says DUPLICATE, break down the canonical issue instead; if it is closed, ask the user first. Its children so far: ?8 (${ids.h}).`,
    );
    expect(l).toContain(
      `4. Open the children in order with issues_open, template "task", parent "${ids.g}", and depends_on naming the earlier children (by the ids issues_open returned) that must be finished first. Fill every required section.`,
    );
    expect(l.at(-1)).toBe(
      "6. Don't close or edit ?7 itself: it is finished when its children are. Tell the user the children's ids.",
    );
  });

  it("issues_breakdown shows a duplicate's warning", async () => {
    const l = await lines("issues_breakdown", { id: "2", template: "bug" });
    expect(l.slice(2, 5)).toEqual([
      `?2 (${ids.b}) · closed`,
      "DUPLICATE of ?1 (in-progress). Track work on ?1; read issues://issue/1.",
      "",
    ]);
    expect(l[5]).toMatch(/Its children so far: none\.$/);
    expect(l.find((x) => x.startsWith("4. "))).toContain(`template "bug", parent "${ids.b}"`);
  });

  it.each([
    [
      "issues_from_discussion",
      { template: "nope" },
      "unknown template nope; issues_templates lists them",
    ],
    ["issues_from_discussion", { parent: "999" }, "unknown issue 999"],
    ["issues_breakdown", { id: "999" }, "unknown issue 999"],
    ["issues_breakdown", { id: "1", template: "nope" }, "unknown template nope"],
    ["issues_breakdown", {}, "missing argument id"],
    ["issues_from_discussion", { bogus: "x" }, "unknown argument bogus"],
  ])("%s %j answers -32602", async (name, args, message) => {
    const err = await mcpError(client.getPrompt({ name, arguments: args }));
    expect(err.code).toBe(-32602);
    expect(err.message).toContain(message);
  });
});
