/**
 * End to end, the write sessions: the BUILT `issues mcp`, spawned over real stdio and driven by the
 * MCP SDK's client, in a temp git repository set up with the CLI (design §6.9, §7.7). The helpers
 * are in `test-support/mcp-stdio.ts`. Sessions W1–W6, W8 and W9: every write tool, the close policy
 * of design §7.3's Table A at startup and while running, `auto_commit`, and who a write is recorded
 * as (Table C). `mcp-e2e.table-b.test.ts` runs session W7.
 */
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, describe, expect, it } from "vitest";
import { linkBins, REPO_HUMAN, runIssues } from "./test-support/cli.js";
import { cli, ME, mcpError, type WriteIssues, writeRepo } from "./test-support/mcp.js";
import {
  ALL_NAMES,
  CONFIG,
  call,
  doc,
  git,
  lastEvent,
  NO_IDENTITY,
  names,
  REASON,
  rules,
  STARTUP_WARNING,
  setPolicy,
  startMcp,
  TASK,
  TIMEOUT,
  WITHOUT_CLOSE,
  WRITE_NAMES,
  write,
} from "./test-support/mcp-stdio.js";

describe("issues mcp writes over stdio (built)", () => {
  const repos: TempRepo[] = [];
  afterAll(async () => {
    for (const r of repos.splice(0)) await r.dispose();
  });
  async function setup(
    files: Record<string, string> = {},
  ): Promise<{ r: TempRepo; ids: WriteIssues }> {
    const s = await writeRepo(files);
    repos.push(s.r);
    return s;
  }

  it(
    "session W1: every write tool, as the client acting for ARK_ON_BEHALF_OF",
    async () => {
      const { r, ids } = await setup({
        [CONFIG]: '[log]\nindex = "committed"\n\n[labels]\nexclusive = ["type"]\n',
      });
      const head = git(r, "rev-parse", "HEAD");
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });

      // Table A row 1: issues_close listed, issues_reopen answers −32602.
      expect(await names(s)).toEqual(ALL_NAMES);
      const reopen = await mcpError(call(s, "issues_reopen", { id: ids.d, reason: "x" }));
      expect(reopen.code).toBe(-32602);
      expect(reopen.message).toContain(
        "issues_reopen is not available: reopening is left to people",
      );

      // issues_open: complete, then only the goal (lint as data); the index stays fresh.
      const opened = await write(s, "issues_open", { title: "Rotate keys", sections: TASK }, "new");
      expect(opened).toMatchObject({ ok: true, findings: [], commit: null, notes: [] });
      expect(opened.written).toContain("docs/issues/index.md");
      const k = opened.issue?.id ?? "";
      expect(lastEvent(r, k)).toMatchObject({
        type: "opened",
        actor: { kind: "agent", agent: "e2e-agent", on_behalf_of: ME },
      });
      const draft = await write(
        s,
        "issues_open",
        { title: "Half done", sections: { goal: "Only the goal." }, labels: ["type:feature"] },
        "new",
      );
      expect(draft.ok).toBe(true);
      expect(rules(draft).length).toBeGreaterThan(0);
      expect(rules(draft).every((x) => x.startsWith("template/"))).toBe(true);
      expect(draft.text).toContain("Fill in: Done when");

      // issues_update fills in what the draft lacked.
      const filled = await write(
        s,
        "issues_update",
        { id: draft.issue?.id, sections: { done: "It is done." } },
        "edit",
      );
      expect(filled).toMatchObject({ ok: true, findings: [] });

      // issues_start assigns the person acted for; a blocked issue starts with a warning.
      const started = await write(s, "issues_start", { id: k }, "start");
      expect(started.issue).toMatchObject({ state: "in-progress", assignees: [ME] });
      const blocked = await write(s, "issues_start", { id: ids.c }, "start");
      expect(blocked.ok).toBe(true);
      expect(rules(blocked)).toContain("issue/started-blocked");
      const stopped = await write(
        s,
        "issues_stop",
        { id: k, reason: "waiting for review" },
        "stop",
      );
      expect(stopped.issue?.state).toBe("open");
      const comment = await write(
        s,
        "issues_comment",
        { id: ids.e, text: "Looked at it." },
        "comment",
      );
      expect(comment.text).toContain(`Commented on ?5 (${ids.e})`);

      // issues_link twice: the second writes nothing, with a note; then issues_unlink.
      const link = { id: k, to: ids.e, rel: "depends-on" };
      expect((await write(s, "issues_link", link, "link")).written.length).toBeGreaterThan(0);
      const again = await write(s, "issues_link", link, "link");
      expect(again).toMatchObject({ ok: true, written: [] });
      expect(again.notes.join("\n")).toContain("already linked");
      expect((await write(s, "issues_unlink", link, "unlink")).ok).toBe(true);

      // issues_label, issues_assign, issues_scope.
      const label = await write(s, "issues_label", { id: ids.e, add: ["type:bug"] }, "label");
      expect(label.issue?.labels).toEqual(["type:bug"]);
      expect(label.notes).toContain("replaced type:feature (type is exclusive)");
      const assign = await write(s, "issues_assign", { id: ids.e, add: ["me"] }, "assign");
      expect(assign.issue?.assignees).toEqual([ME]);
      const scope = await write(s, "issues_scope", { id: ids.e, add: ["src/later/**"] }, "scope");
      expect(scope.notes.join("\n")).toContain("src/later/** matches no tracked file");

      // issues_close: no reason is a refusal result, not an error; then with a reason.
      const bare = await write(s, "issues_close", { id: k }, "close");
      expect(bare.ok).toBe(false);
      expect(rules(bare)).toContain("issue/agent-reason-required");
      expect(bare.text).toContain("Call issues_close again with a reason");
      const done = await write(s, "issues_close", { id: k, reason: REASON }, "close");
      expect(done).toMatchObject({ ok: true, issue: { state: "closed" } });
      const dup = await write(
        s,
        "issues_close",
        { id: ids.g, resolution: "duplicate", of: ids.e, reason: "same work" },
        "close",
      );
      expect(dup.ok).toBe(true);
      expect(dup.affected.map((v) => v.id)).toEqual([ids.e]);
      const twice = await write(s, "issues_close", { id: k, reason: REASON }, "close");
      expect(twice.ok).toBe(false);
      expect(rules(twice)).toEqual(["transition/illegal"]);

      // Nothing was committed, everything is staged, and the staged index is current.
      expect(git(r, "rev-parse", "HEAD")).toBe(head);
      expect(git(r, "diff", "--name-only")).toBe("");
      expect(git(r, "diff", "--cached", "--name-only")).toContain("docs/issues/index.md");
      expect(runIssues(r, ["index", "--check"]).status).toBe(0);
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "session W2: mcp_can_close = false at startup, and turned on needs a restart",
    async () => {
      const { r, ids } = await setup();
      await setPolicy(r, "[policy]\nmcp_can_close = false\n", true);
      const off = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(off)).toEqual(WITHOUT_CLOSE);
      const close = await mcpError(call(off, "issues_close", { id: ids.e, reason: REASON }));
      expect(close.code).toBe(-32602);
      expect(close.message).toContain(
        `issues_close is not available: [policy] mcp_can_close is false in ${CONFIG}; a person closes issues with the issues CLI, or set it to true and restart issues mcp`,
      );
      const reopen = await mcpError(call(off, "issues_reopen", { id: ids.d, reason: "x" }));
      expect(reopen.message).toContain("reopening is left to people");
      // Turned on while running: still not listed until a restart.
      await setPolicy(r, "[policy]\nmcp_can_close = true\n", true);
      expect(await names(off)).toEqual(WITHOUT_CLOSE);
      expect(await off.close()).toBe(0);
      expect(off.stderr()).toBe("");
      const on = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(on)).toEqual(ALL_NAMES);
      expect(await on.close()).toBe(0);

      // Table A row 4: both keys set; not listed, and no warning.
      await setPolicy(r, "[policy]\nmcp_can_close = false\nclose_requires_human = true\n", true);
      const both = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(both)).toEqual(WITHOUT_CLOSE);
      const refused = await mcpError(call(both, "issues_close", { id: ids.e, reason: REASON }));
      expect(refused.message).toContain("mcp_can_close is false");
      expect(await both.close()).toBe(0);
      expect(both.stderr()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "session W3: close_requires_human = true warns at startup and refuses agents, not people",
    async () => {
      const { r, ids } = await setup();
      await setPolicy(r, "[policy]\nclose_requires_human = true\n", true);
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      expect(await names(s)).toEqual(ALL_NAMES);
      const close = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(close.ok).toBe(false);
      expect(rules(close)).toContain("issue/agent-closed");
      expect(close.text).toContain("The issue log's policy keeps closing to people");
      const reopen = await mcpError(call(s, "issues_reopen", { id: ids.d, reason: "x" }));
      expect(reopen.message).toContain("reopening is left to people");
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe(STARTUP_WARNING);

      // Table C, the CLI rows: a person's close isn't policed; an agent's is; agents may reopen.
      expect(runIssues(r, ["close", ids.e, "--reason", "done by hand"]).status).toBe(0);
      const agent = { ARK_AGENT: "kiro", ARK_ON_BEHALF_OF: ME };
      const cliClose = runIssues(r, ["close", ids.g, "--reason", REASON, "--json"], { env: agent });
      expect(cliClose.status).toBe(1);
      expect(cliClose.stdout).toContain("issue/agent-closed");
      const cliReopen = runIssues(r, ["reopen", ids.e, "--reason", "not done after all"], {
        env: agent,
      });
      expect(cliReopen.status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session W4: policy keys changed while running take effect at the next close",
    async () => {
      const { r, ids } = await setup();
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      await setPolicy(r, "[policy]\nmcp_can_close = false\n");
      expect(await names(s)).toEqual(ALL_NAMES);
      const off = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(off.ok).toBe(false);
      expect(rules(off)).toContain("issue/agent-closed");

      await setPolicy(r, "[policy]\nclose_requires_human = true\n");
      const human = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(human.ok).toBe(false);
      expect(rules(human)).toContain("issue/agent-closed");

      await setPolicy(r, "[policy]\nclose_requires_human = false\n");
      const through = await write(s, "issues_close", { id: ids.e, reason: REASON }, "close");
      expect(through).toMatchObject({ ok: true, issue: { state: "closed" } });
      expect(await s.close()).toBe(0);
      expect(s.stderr()).toBe("");
    },
    TIMEOUT,
  );

  it(
    "session W5: with auto_commit and the hooks, writes commit and incomplete ones are refused",
    async () => {
      const { r } = await setup({
        ".gitignore": "node_modules/\n",
        [CONFIG]: '[log]\nindex = "committed"\n\n[policy]\nauto_commit = true\n',
      });
      await linkBins(r.root);
      cli(r, ["hooks", "install"]);
      const s = await startMcp(r, { ARK_ON_BEHALF_OF: ME });
      const status = git(r, "status", "--porcelain");
      const head = git(r, "rev-parse", "HEAD");

      const half = await write(
        s,
        "issues_open",
        { title: "Half done", sections: { goal: "Only the goal." } },
        "new",
      );
      expect(half).toMatchObject({ ok: false, issue: null, written: [], commit: null });
      expect(half.text).toContain("Fill in every required section and call issues_open again.");
      expect(git(r, "status", "--porcelain")).toBe(status);
      expect(git(r, "rev-parse", "HEAD")).toBe(head);

      const opened = await write(s, "issues_open", { title: "Rotate keys", sections: TASK }, "new");
      expect(opened.ok).toBe(true);
      expect(opened.commit).not.toBeNull();
      expect(opened.text).toContain(`Committed ${opened.commit?.slice(0, 7)}`);
      expect(git(r, "log", "-1", "--format=%s").trim()).toBe('docs(issues): open "rotate keys"');
      expect(git(r, "status", "--porcelain")).toBe(status);
      expect(runIssues(r, ["index", "--check"]).status).toBe(0);

      const id = opened.issue?.id ?? "";
      const update = await write(s, "issues_update", { id, sections: { done: "" } }, "edit");
      expect(update).toMatchObject({ ok: false, written: [], commit: null });
      expect(git(r, "status", "--porcelain")).toBe(status);

      const closed = await write(s, "issues_close", { id, reason: REASON }, "close");
      expect(closed.commit).not.toBeNull();
      expect(git(r, "log", "-1", "--format=%B")).toContain(`Issue: ${id}\nIssue-Event: closed`);
      // A closed issue isn't linted, so its update commits.
      const late = await write(s, "issues_update", { id, sections: { done: "" } }, "edit");
      expect(late.ok).toBe(true);
      expect(late.commit).not.toBeNull();
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session W6: without ARK_ON_BEHALF_OF, a write acts for the git identity, with a note",
    async () => {
      const { r, ids } = await setup();
      const s = await startMcp(r, {});
      const comment = await write(s, "issues_comment", { id: ids.e, text: "Noted." }, "comment");
      expect(comment.notes).toContain(
        `on_behalf_of taken from the git identity ${REPO_HUMAN.email}; set ARK_ON_BEHALF_OF to name who you act for`,
      );
      expect(comment.text).toContain(`Note: on_behalf_of taken from the git identity`);
      expect(lastEvent(r, ids.e)).toMatchObject({
        type: "commented",
        actor: { kind: "agent", agent: "e2e-agent", on_behalf_of: REPO_HUMAN.email },
      });
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session W8: without ARK_ON_BEHALF_OF and a git identity, every write is a config error",
    async () => {
      const { r, ids } = await setup();
      const s = await startMcp(r, NO_IDENTITY);
      const args: Record<string, Record<string, unknown>> = {
        issues_open: { title: "Nobody's" },
        issues_update: { id: ids.e, title: "Nobody's" },
        issues_comment: { id: ids.e, text: "x" },
        issues_start: { id: ids.e },
        issues_stop: { id: ids.a },
        issues_close: { id: ids.e, reason: REASON },
        issues_link: { id: ids.e, to: ids.g },
        issues_unlink: { id: ids.e, to: ids.g },
        issues_label: { id: ids.e, add: ["type:bug"] },
        issues_assign: { id: ids.e, add: ["me"] },
        issues_scope: { id: ids.e, add: ["README.md"] },
      };
      expect(Object.keys(args)).toEqual(WRITE_NAMES);
      const before = git(r, "status", "--porcelain");
      for (const [name, a] of [
        ...Object.entries(args),
        ["issues_list", { assignee: ["me"] }],
        ["issues_ready", { mine: true }],
      ] as const) {
        const res = await call(s, name, a);
        expect(res.isError, name).toBe(true);
        expect(doc(res), name).toMatchObject({
          format: "ark-error/v1",
          error: { code: "config", message: expect.stringMatching(/^no git identity/) },
        });
      }
      expect(git(r, "status", "--porcelain")).toBe(before);
      expect((await call(s, "issues_list")).isError).toBeUndefined();
      expect(await s.close()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "session W9: a client name that can't be an agent name is recorded as ARK_AGENT or mcp-client",
    async () => {
      const { r, ids } = await setup();
      const robot = await startMcp(r, { ARK_ON_BEHALF_OF: ME }, "🤖");
      const plain = await write(robot, "issues_comment", { id: ids.e, text: "1" }, "comment");
      expect(plain.notes).toContain(
        "the MCP client sent no usable name; recorded as agent mcp-client",
      );
      expect(lastEvent(r, ids.e)?.actor).toMatchObject({ kind: "agent", agent: "mcp-client" });
      expect(await robot.close()).toBe(0);

      const kiro = await startMcp(r, { ARK_ON_BEHALF_OF: ME, ARK_AGENT: "kiro" }, "🤖");
      const named = await write(kiro, "issues_comment", { id: ids.e, text: "2" }, "comment");
      expect(named.notes).toContain("the MCP client sent no usable name; recorded as agent kiro");
      expect(lastEvent(r, ids.e)?.actor).toMatchObject({
        kind: "agent",
        agent: "kiro",
        on_behalf_of: ME,
      });
      expect(await kiro.close()).toBe(0);
    },
    TIMEOUT,
  );
});
