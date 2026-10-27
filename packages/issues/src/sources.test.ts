import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { acceptDecision, openDecisionLog, proposeDecision } from "@nikovirtala/adr";
import { type Actor, ConfigError } from "@nikovirtala/ledger";
import { createTempRepo, type TempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { openIssueLog } from "./log.js";
import { readDecisionLog, readSourceLogs } from "./sources.js";

const run = promisify(execFile);
const HUMAN: Actor = {
  kind: "human",
  name: "Ledger Test",
  email: "ledger-test@example.com",
  agent: null,
  on_behalf_of: null,
};
const NYGARD = {
  context: "We need a queue.",
  decision: "We will use a queue.",
  scope: "services/orders",
  consequences: "One more service.",
};

/** Proposes and (unless `accept` is false) accepts a decision with adr's library; its id. */
async function decide(repo: TempRepo, title: string, accept = true): Promise<string> {
  const log = await openDecisionLog({ cwd: repo.root, gitOptions: { env: repo.env } });
  const p = await proposeDecision(log, { title, sections: NYGARD, actor: HUMAN }, { commit: true });
  const id = p.decision?.id;
  if (!p.ok || id === undefined) throw new Error(`can't propose ${title}`);
  if (accept) {
    const a = await acceptDecision(log, { id, actor: HUMAN }, { commit: true });
    if (!a.ok) throw new Error(`can't accept ${title}`);
  }
  return id;
}

const openIn = (cwd: string, env: NodeJS.ProcessEnv) => openIssueLog({ cwd, gitOptions: { env } });

describe("the local decision log", () => {
  it("is absent without an adr config or decisions", async () => {
    await using repo = await createTempRepo({ files: { "README.md": "x\n" } });
    const log = await openIn(repo.root, repo.env);
    expect(await readDecisionLog(log)).toBeNull();
    expect([...(await readSourceLogs(log)).keys()]).toEqual([]);
  });

  it("is read with adr's numbers and statuses when present", async () => {
    await using repo = await createTempRepo({ files: { "README.md": "x\n" } });
    const accepted = await decide(repo, "Use queues");
    const proposed = await decide(repo, "Cache totals", false);
    const log = await openIn(repo.root, repo.env);
    const d = await readDecisionLog(log);
    expect(d?.root).toBe("docs/adr");
    expect(d?.views.get(accepted)).toMatchObject({ display: "ADR-0001", status: "accepted" });
    expect(d?.views.get(proposed)).toMatchObject({ display: proposed, status: "proposed" });
    const sources = await readSourceLogs(log);
    expect(sources.get("adr")).toMatchObject({ kind: "adr", local: true });
    expect(sources.get("adr")?.subjects?.get(accepted)).toEqual({
      status: "accepted",
      display: "ADR-0001",
      title: "Use queues",
      effective: accepted,
    });
  });

  it("refuses an invalid adr main_branch or index, naming adr's file", async () => {
    for (const [toml, message] of [
      ['[log]\nmain_branch = "-x"\n', "docs/adr/adr.toml: log.main_branch must be a ref name"],
      ['[log]\nindex = "comitted"\n', 'docs/adr/adr.toml: log.index must be "committed" or "none"'],
    ] as const) {
      await using repo = await createTempRepo({ files: { "docs/adr/adr.toml": toml } });
      const log = await openIn(repo.root, repo.env);
      const err = await readDecisionLog(log).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(message);
    }
  });

  it("returns uncached [[sources]] unread, so they aren't checked", async () => {
    await using repo = await createTempRepo({
      files: {
        "docs/issues/issues.toml":
          '[[sources]]\nname = "platform"\nkind = "issues"\nurl = "https://example.com/p.git"\nref = "main"\n',
      },
    });
    const sources = await readSourceLogs(await openIn(repo.root, repo.env));
    expect(sources.get("platform")).toEqual({
      kind: "issues",
      local: false,
      subjects: null,
      commit: null,
    });
  });

  describe("in a shallow clone", () => {
    async function shallowClone(
      index: "committed" | "none",
    ): Promise<{ dir: string; env: NodeJS.ProcessEnv; id: string; cleanup: () => Promise<void> }> {
      const repo = await createTempRepo({
        files: { "docs/adr/adr.toml": `[log]\nindex = "${index}"\n` },
      });
      const id = await decide(repo, "Use queues");
      await repo.commit("two", { allowEmpty: true });
      const dir = await mkdtemp(join(tmpdir(), "issues-shallow-"));
      await run("git", ["clone", "-q", "--depth", "1", `file://${repo.root}`, join(dir, "c")], {
        env: { ...process.env, ...repo.env } as NodeJS.ProcessEnv,
      });
      return {
        dir: join(dir, "c"),
        env: repo.env,
        id,
        cleanup: async () => {
          await repo.dispose();
          await rm(dir, { recursive: true, force: true });
        },
      };
    }

    it("takes decision numbers from adr's committed index.md", async () => {
      const c = await shallowClone("committed");
      try {
        const d = await readDecisionLog(await openIn(c.dir, c.env));
        expect(d?.numbering).toMatchObject({ available: true, reason: "index" });
        expect(d?.views.get(c.id)?.display).toBe("ADR-0001");
      } finally {
        await c.cleanup();
      }
    });

    it('has no decision numbers with adr\'s index = "none"', async () => {
      const c = await shallowClone("none");
      try {
        const d = await readDecisionLog(await openIn(c.dir, c.env));
        expect(d?.numbering).toMatchObject({ available: false, reason: "shallow" });
        expect(d?.views.get(c.id)?.display).toBe(c.id);
      } finally {
        await c.cleanup();
      }
    });
  });
});
