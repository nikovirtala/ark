import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptDecision, openDecisionLog, proposeDecision } from "@nikovirtala/adr";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { describe, expect, it } from "vitest";
import { cliEnv, cliRepo, newIssue, REPO_HUMAN, runIssues, runJson } from "../test-support/cli.js";

type Write = {
  ok: boolean;
  issue: { depends_on: string[]; implements: string[]; parent: string | null } | null;
  written: string[];
  findings: { rule: string }[];
  notes: string[];
};
type Show = {
  references: {
    rel: string;
    to: string;
    display: string;
    status: string | null;
    checked: boolean;
  }[];
  notes: string[];
};

const NYGARD = {
  context: "We need a queue.",
  decision: "We will use a queue.",
  scope: "services/orders",
  consequences: "One more service.",
};

async function decide(repo: TempRepo, title: string): Promise<string> {
  const log = await openDecisionLog({ cwd: repo.root, gitOptions: { env: repo.env } });
  const p = await proposeDecision(
    log,
    { title, sections: NYGARD, actor: REPO_HUMAN },
    { commit: true },
  );
  const id = p.decision?.id ?? "";
  const a = await acceptDecision(log, { id, actor: REPO_HUMAN }, { commit: true });
  if (!a.ok) throw new Error("accept failed");
  return id;
}

function event(subject: string, to: string): string {
  return [
    "envelope: ledger/v1",
    "kind: issue",
    "schema: issue/v1",
    "id: 01J00000000000000000000000",
    `subject: ${subject}`,
    "type: linked",
    "at: 2099-01-01T00:00:00Z",
    "actor:",
    "  kind: human",
    "  name: Test",
    "  email: test@example.com",
    "  agent: null",
    "  on_behalf_of: null",
    "data:",
    `  to: ${JSON.stringify(to)}`,
    "  rel: relates-to",
    "",
  ].join("\n");
}

describe("issues link and unlink", () => {
  it("resolve every target form, and say when a link exists or is absent", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    const two = newIssue(repo, "Two");
    const r = runJson<Write>(repo, ["link", "1", "?2", "--rel", "depends-on"]);
    expect(r.status).toBe(0);
    expect(r.json.issue?.depends_on).toEqual([two]);
    const again = runJson<Write>(repo, ["link", "1", two, "--rel", "depends-on"]);
    expect(again.json.written).toEqual([]);
    expect(again.json.notes).toContain("already linked: ?1 depends-on ?2; nothing written");
    expect(runJson<Write>(repo, ["link", "1", "0002"]).json.written).toHaveLength(1);
    for (const args of [
      ["link", "1", "1"],
      ["link", "1", "9"],
      ["link", "1", "ADR-0001", "--rel", "depends-on"],
      ["link", "1", "?2", "--rel", "implements"],
      ["link", "1", `issues:${two}`],
      ["link", "1", "2", "--rel", "blocks"],
      ["unlink", "1", "9"],
    ]) {
      expect(runIssues(repo, args).status, args.join(" ")).toBe(2);
    }
    expect(runIssues(repo, ["unlink", "1", "?2"]).status).toBe(2);
    expect(runIssues(repo, ["unlink", "1", "?2"]).stderr).toContain("give --rel");
    expect(
      runJson<Write>(repo, ["unlink", "1", "?2", "--rel", "relates-to"]).json.written,
    ).toHaveLength(1);
    const absent = runJson<Write>(repo, ["unlink", "1", "?2", "--rel", "relates-to"]);
    expect(absent.status).toBe(0);
    expect(absent.json.notes).toContain("not linked: ?1 relates-to ?2; nothing written");
  });

  it("refuses a cycle and a second parent with exit 1", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    newIssue(repo, "Two");
    newIssue(repo, "Three");
    expect(runIssues(repo, ["link", "1", "2", "--rel", "part-of"]).status).toBe(0);
    const second = runJson<Write>(repo, ["link", "1", "3", "--rel", "part-of"]);
    expect(second.status).toBe(1);
    expect(second.json.findings.map((f) => f.rule)).toEqual(["issue/multiple-parents"]);
    expect(second.stderr).toContain("unlink it first: issues unlink ?1 ?2 --rel part-of");
    expect(runIssues(repo, ["link", "2", "1", "--rel", "part-of"]).status).toBe(1);
    expect(runIssues(repo, ["link", "2", "1", "--rel", "relates-to"]).status).toBe(0);
  });

  it("refuses the effective self-loop when the link makes it", async () => {
    await using repo = await cliRepo();
    newIssue(repo, "One");
    newIssue(repo, "Two");
    newIssue(repo, "Three");
    expect(
      runIssues(repo, ["close", "2", "--duplicate-of", "3", "--reason", "same", "--commit"]).status,
    ).toBe(0);
    const r = runJson<Write>(repo, ["link", "3", "2", "--rel", "depends-on"]);
    expect(r.status).toBe(1);
    expect(r.json.findings.map((f) => f.rule)).toEqual(["issue/cycle"]);
    expect(r.json.written).toEqual([]);
  });

  it("removes dangling and unknown-source links, so verify passes again", async () => {
    await using repo = await cliRepo();
    const one = newIssue(repo, "One");
    await repo.write(
      `docs/issues/events/${one}/20990101T000000Z-0000-linked.yaml`,
      event(one, "zzzzzzzz"),
    );
    await repo.write(
      `docs/issues/events/${one}/20990101T000001Z-0001-linked.yaml`,
      event(one, `gone:${one}`)
        .replace("01J00000000000000000000000", "01J00000000000000000000001")
        .replace("2099-01-01T00:00:00Z", "2099-01-01T00:00:01Z"),
    );
    const broken = runIssues(repo, ["verify"]);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain("issue/reference-missing");
    expect(broken.stdout).toContain("issue/unknown-source");
    expect(runIssues(repo, ["unlink", "1", "zzzzzzzz"]).status).toBe(0);
    expect(runIssues(repo, ["unlink", "1", `gone:${one}`]).status).toBe(0);
    expect(runIssues(repo, ["verify"]).status).toBe(0);
  });

  it("links to decisions of the local log, and notes unchecked sources", async () => {
    await using repo = await cliRepo({
      "docs/issues/issues.toml":
        '[[sources]]\nname = "platform"\nkind = "issues"\nurl = "https://example.com/p.git"\nref = "main"\n',
    });
    const decision = await decide(repo, "Use queues");
    newIssue(repo, "One");
    const r = runJson<Write>(repo, ["link", "1", "ADR-0001", "--rel", "implements", "--commit"]);
    expect(r.status).toBe(0);
    expect(r.json.issue?.implements).toEqual([`adr:${decision}`]);
    expect(runIssues(repo, ["link", "1", "platform:zzzzzzzz"]).status).toBe(0);
    const show = runJson<Show>(repo, ["show", "1"]);
    expect(show.json.references).toEqual([
      {
        rel: "implements",
        to: `adr:${decision}`,
        display: "ADR-0001",
        title: "Use queues",
        status: "accepted",
        checked: true,
      },
      {
        rel: "relates-to",
        to: "platform:zzzzzzzz",
        display: "platform:zzzzzzzz",
        title: null,
        status: null,
        checked: false,
      },
    ]);
    expect(show.json.notes).toContain(
      "references into platform are checked against cached copies; run issues sources fetch to update them",
    );
  });

  describe("in a shallow clone", () => {
    async function shallow(index: "committed" | "none") {
      const repo = await cliRepo({ "docs/adr/adr.toml": `[log]\nindex = "${index}"\n` });
      await decide(repo, "Use queues");
      const issue = newIssue(repo, "One");
      const dir = await mkdtemp(join(tmpdir(), "issues-clone-"));
      const clone = join(dir, "c");
      execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo.root}`, clone], {
        env: cliEnv(repo),
      });
      return {
        repo,
        clone,
        issue,
        [Symbol.asyncDispose]: async () => {
          await repo.dispose();
          await rm(dir, { recursive: true, force: true });
        },
      };
    }

    it("resolves ADR-0001 from adr's committed index", async () => {
      await using c = await shallow("committed");
      const r = runJson<Write>(c.repo, ["link", c.issue, "ADR-0001", "--rel", "implements"], {
        cwd: c.clone,
      });
      expect(r.status).toBe(0);
      const show = runJson<Show>(c.repo, ["show", c.issue], { cwd: c.clone });
      expect(show.json.references[0]).toMatchObject({ display: "ADR-0001", status: "accepted" });
    });

    it('has no decision numbers with adr\'s index = "none"', async () => {
      await using c = await shallow("none");
      const r = runIssues(c.repo, ["link", c.issue, "ADR-0001", "--rel", "implements"], {
        cwd: c.clone,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("decision numbers are unavailable");
    });
  });
});
