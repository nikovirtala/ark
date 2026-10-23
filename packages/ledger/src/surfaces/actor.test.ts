import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { Git } from "../git/git.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { parseOnBehalfOf, resolveActor, resolveAttribution } from "./actor.js";

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

/** A `Git` whose only identity source is `identity`; `null` makes reading it fail the test. */
function fakeGit(identity: { name: string; email: string } | null | "unread"): Git {
  return {
    identity: async () => {
      if (identity === "unread") throw new Error("the git identity must not be read");
      return identity;
    },
  } as unknown as Git;
}

describe("resolveAttribution", () => {
  const niko = { name: "Niko", email: "niko@example.com" };
  const FOR = "nikovirtala@users.noreply.github.com";

  it("records a human with the git identity and no note", async () => {
    expect(await resolveAttribution(fakeGit(niko), { env: {} })).toEqual({
      actor: {
        kind: "human",
        name: "Niko",
        email: "niko@example.com",
        agent: null,
        on_behalf_of: null,
      },
      notes: [],
    });
  });

  it("ignores ARK_ON_BEHALF_OF without ARK_AGENT, with a note", async () => {
    expect(await resolveAttribution(fakeGit(niko), { env: { ARK_ON_BEHALF_OF: FOR } })).toEqual({
      actor: {
        kind: "human",
        name: "Niko",
        email: "niko@example.com",
        agent: null,
        on_behalf_of: null,
      },
      notes: [
        "ARK_ON_BEHALF_OF is ignored without ARK_AGENT; events are recorded as Niko <niko@example.com>",
      ],
    });
  });

  it("records an agent for ARK_ON_BEHALF_OF without reading the git identity", async () => {
    const env = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: ` ${FOR} ` };
    expect(await resolveAttribution(fakeGit("unread"), { env })).toEqual({
      actor: { kind: "agent", name: "kiro", email: null, agent: "kiro", on_behalf_of: FOR },
      notes: [],
    });
    expect(await resolveAttribution(fakeGit(null), { env })).toMatchObject({ notes: [] });
  });

  it("records an agent for the git identity's email, with a note", async () => {
    expect(await resolveAttribution(fakeGit(niko), { env: { ARK_AGENT: "kiro" } })).toEqual({
      actor: {
        kind: "agent",
        name: "kiro",
        email: null,
        agent: "kiro",
        on_behalf_of: "niko@example.com",
      },
      notes: [
        "on_behalf_of taken from the git identity niko@example.com; set ARK_ON_BEHALF_OF to name who you act for",
      ],
    });
  });

  it("treats empty and blank values as unset", async () => {
    const env = { ARK_AGENT: " ", ARK_ON_BEHALF_OF: "  " };
    expect(await resolveAttribution(fakeGit(niko), { env })).toMatchObject({
      actor: { kind: "human" },
      notes: [],
    });
    expect(
      await resolveAttribution(fakeGit(niko), { env: { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "" } }),
    ).toMatchObject({
      actor: { on_behalf_of: "niko@example.com" },
    });
  });

  it("refuses an invalid ARK_ON_BEHALF_OF even when it wouldn't be used", async () => {
    for (const env of [
      { ARK_ON_BEHALF_OF: "niko" },
      { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: "niko" },
    ]) {
      const e = await resolveAttribution(fakeGit(niko), { env }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe('ARK_ON_BEHALF_OF "niko" is not an email address');
    }
  });

  it("needs a git identity unless an agent acts for ARK_ON_BEHALF_OF", async () => {
    for (const env of [{}, { ARK_AGENT: "kiro" }, { ARK_ON_BEHALF_OF: FOR }]) {
      await expect(resolveAttribution(fakeGit(null), { env })).rejects.toThrow(
        "no git identity; set git user.name and user.email",
      );
    }
  });

  it("takes on_behalf_of from GIT_AUTHOR_EMAIL over user.email", async () => {
    const r = await repo();
    await r.git.run(["config", "user.name", "Config User"]);
    await r.git.run(["config", "user.email", "config@example.com"]);
    const git = await Git.open(r.root, {
      env: { ...r.env, GIT_AUTHOR_EMAIL: "author@example.com" },
    });
    const a = await resolveAttribution(git, { env: { ARK_AGENT: "kiro" } });
    expect(a.actor.on_behalf_of).toBe("author@example.com");
    const plain = await Git.open(r.root, {
      env: { ...r.env, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined },
    });
    expect(
      (await resolveAttribution(plain, { env: { ARK_AGENT: "kiro" } })).actor.on_behalf_of,
    ).toBe("config@example.com");
  });

  it("is what resolveActor returns", async () => {
    const env = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: FOR };
    expect(await resolveActor(fakeGit("unread"), { env })).toEqual(
      (await resolveAttribution(fakeGit("unread"), { env })).actor,
    );
  });
});

describe("parseOnBehalfOf", () => {
  it("accepts an email address, trimmed, and treats blank as unset", () => {
    expect(parseOnBehalfOf(undefined)).toBeNull();
    expect(parseOnBehalfOf(" \t")).toBeNull();
    expect(parseOnBehalfOf(" nikovirtala@users.noreply.github.com ")).toBe(
      "nikovirtala@users.noreply.github.com",
    );
    expect(parseOnBehalfOf(`${"a".repeat(242)}@example.com`)).toHaveLength(254);
  });

  it.each([
    ["niko", 'ARK_ON_BEHALF_OF "niko" is not an email address'],
    ["Niko <niko@x.org>", 'ARK_ON_BEHALF_OF "Niko <niko@x.org>" is not an email address'],
    ["a@b@c", 'ARK_ON_BEHALF_OF "a@b@c" is not an email address'],
    ["a b@c", 'ARK_ON_BEHALF_OF "a b@c" is not an email address'],
    ["@c", 'ARK_ON_BEHALF_OF "@c" is not an email address'],
    [
      `${"a".repeat(243)}@example.com`,
      `ARK_ON_BEHALF_OF ${JSON.stringify("a".repeat(100))} is not an email address`,
    ],
  ])("refuses %j", (value, message) => {
    expect(() => parseOnBehalfOf(value)).toThrow(ConfigError);
    expect(() => parseOnBehalfOf(value)).toThrow(message);
  });
});
