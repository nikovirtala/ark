import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { Git } from "../git/git.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { mcpAgentName, mcpAttribution } from "./attribution.js";

const AGENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo();
  repos.push(r);
  return r;
}

describe("mcpAgentName", () => {
  it.each<[string | null | undefined, string | null]>([
    ["kiro", "kiro"],
    ["Claude Code", "Claude Code"],
    ["@acme/agent 2", "acme-agent 2"],
    ["  spaced  ", "spaced"],
    ["a//b", "a-b"],
    ["🤖", null],
    ["", null],
    ["!!!", null],
    [null, null],
    [undefined, null],
    ["x".repeat(200), "x".repeat(64)],
    [`${"x".repeat(63)} y`, "x".repeat(63)],
  ])("%j → %j", (name, expected) => {
    expect(mcpAgentName(name)).toBe(expected);
  });

  it("returns null or an agent name ledger accepts", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 100 }), (s) => {
        const r = mcpAgentName(s);
        expect(r === null || AGENT.test(r)).toBe(true);
      }),
    );
  });
});

describe("mcpAttribution", () => {
  const FOR = "niko@example.com";
  const client = (name: string) => ({ name, version: "1" });
  const IDENTITY = "ledger-test@example.com";

  it("records the client as an agent for ARK_ON_BEHALF_OF, without a note", async () => {
    const r = await repo();
    const ctx = { client: client("kiro"), env: { ARK_ON_BEHALF_OF: FOR, ARK_AGENT: "other" } };
    expect(await mcpAttribution(r.git, ctx)).toEqual({
      actor: { kind: "agent", name: "kiro", email: null, agent: "kiro", on_behalf_of: FOR },
      notes: [],
    });
  });

  it("acts for the git identity without ARK_ON_BEHALF_OF, with the note", async () => {
    const r = await repo();
    expect(await mcpAttribution(r.git, { client: client("kiro"), env: {} })).toEqual({
      actor: { kind: "agent", name: "kiro", email: null, agent: "kiro", on_behalf_of: IDENTITY },
      notes: [
        `on_behalf_of taken from the git identity ${IDENTITY}; set ARK_ON_BEHALF_OF to name who you act for`,
      ],
    });
  });

  it("notes a cleaned client name before the identity note", async () => {
    const r = await repo();
    const a = await mcpAttribution(r.git, { client: client("@acme/agent 2"), env: {} });
    expect(a.actor.agent).toBe("acme-agent 2");
    expect(a.notes).toEqual([
      'MCP client name "@acme/agent 2" is recorded as agent "acme-agent 2"',
      expect.stringContaining("on_behalf_of taken from the git identity"),
    ]);
  });

  it("falls back to ARK_AGENT, then mcp-client, when the client name is unusable", async () => {
    const r = await repo();
    const env = { ARK_ON_BEHALF_OF: FOR };
    const fromEnv = await mcpAttribution(r.git, {
      client: client("🤖"),
      env: { ...env, ARK_AGENT: "kiro" },
    });
    expect(fromEnv.actor.agent).toBe("kiro");
    expect(fromEnv.notes).toEqual(["the MCP client sent no usable name; recorded as agent kiro"]);
    const none = await mcpAttribution(r.git, { client: null, env });
    expect(none.actor).toMatchObject({ kind: "agent", agent: "mcp-client", on_behalf_of: FOR });
    expect(none.notes).toEqual([
      "the MCP client sent no usable name; recorded as agent mcp-client",
    ]);
    await expect(
      mcpAttribution(r.git, { client: null, env: { ...env, ARK_AGENT: "bad/name" } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("needs a git identity only without ARK_ON_BEHALF_OF", async () => {
    const r = await repo();
    const git = await Git.open(r.root, {
      env: { ...r.env, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined },
    });
    const ctx = { client: client("kiro"), env: { ARK_ON_BEHALF_OF: FOR } };
    expect((await mcpAttribution(git, ctx)).actor.on_behalf_of).toBe(FOR);
    const without = mcpAttribution(git, { client: client("kiro"), env: {} });
    await expect(without).rejects.toBeInstanceOf(ConfigError);
    await expect(without).rejects.toThrow("no git identity");
    await expect(
      mcpAttribution(git, { client: client("kiro"), env: { ARK_ON_BEHALF_OF: "nope" } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
