import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { Git } from "../git/git.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { resolveActor } from "./actor.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(): Promise<TempRepo> {
  const r = await createTempRepo();
  repos.push(r);
  return r;
}

const HUMAN = {
  kind: "human",
  name: "Ledger Test",
  email: "ledger-test@example.com",
  agent: null,
  on_behalf_of: null,
};

describe("resolveActor", () => {
  it("is the git identity as a human by default", async () => {
    const r = await repo();
    expect(await resolveActor(r.git, { env: {} })).toEqual(HUMAN);
    expect(await resolveActor(r.git, { env: { ARK_AGENT: "  " } })).toEqual(HUMAN);
    expect(await resolveActor(r.git, { env: { ARK_AGENT: "x" }, agent: "" })).toEqual(HUMAN);
  });

  it("reads ARK_AGENT from process.env when no env is given", async () => {
    const r = await repo();
    const saved = process.env.ARK_AGENT;
    process.env.ARK_AGENT = "env-agent";
    try {
      expect((await resolveActor(r.git)).agent).toBe("env-agent");
    } finally {
      if (saved === undefined) delete process.env.ARK_AGENT;
      else process.env.ARK_AGENT = saved;
    }
  });

  it("is an agent acting for the git identity when ARK_AGENT or agent names one", async () => {
    const r = await repo();
    const agent = (name: string) => ({
      kind: "agent",
      name,
      email: null,
      agent: name,
      on_behalf_of: "ledger-test@example.com",
    });
    expect(await resolveActor(r.git, { env: { ARK_AGENT: " Claude Code 4.1 " } })).toEqual(
      agent("Claude Code 4.1"),
    );
    expect(await resolveActor(r.git, { env: { ARK_AGENT: "a" }, agent: "mcp-client" })).toEqual(
      agent("mcp-client"),
    );
    expect(await resolveActor(r.git, { env: { ARK_AGENT: "a".repeat(64) } })).toEqual(
      agent("a".repeat(64)),
    );
  });

  it.each([["-agent"], [".agent"], ["a".repeat(65)], ["bot/1"], ["bot\tone"], ["bot:1"]])(
    "refuses ARK_AGENT=%j",
    async (value) => {
      const r = await repo();
      const e = await resolveActor(r.git, { env: { ARK_AGENT: value } }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/^ARK_AGENT ".*" must match/);
    },
  );

  it("names the agent option, not ARK_AGENT, when the caller passed it", async () => {
    const r = await repo();
    await expect(resolveActor(r.git, { env: {}, agent: "bad/name" })).rejects.toThrow(
      /^agent name "bad\/name" must match/,
    );
  });

  it("refuses without a configured identity instead of guessing one", async () => {
    const r = await repo();
    const env = {
      ...r.env,
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      EMAIL: "guess@example.com",
    };
    const git = await Git.open(r.root, { env });
    const human = resolveActor(git, { env: {} });
    await expect(human).rejects.toBeInstanceOf(ConfigError);
    await expect(human).rejects.toThrow("set git user.name and user.email");
    await expect(resolveActor(git, { env: { ARK_AGENT: "bot" } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});
