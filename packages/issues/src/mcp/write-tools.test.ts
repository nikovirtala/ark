import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runGit, runJson, WRITE_KEYS } from "../test-support/cli.js";
import {
  connectMcp,
  ME,
  mcpError,
  structured,
  text,
  type WriteIssues,
  writeRepo,
} from "../test-support/mcp.js";
import { type RowRepo, runTableB, TABLE_B } from "../test-support/write-cells.js";
import { REOPEN_REASON } from "./policy.js";

const repos: TempRepo[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closes.splice(0)) await c();
  for (const r of repos.splice(0)) await r.dispose();
});

async function setup(
  files: Record<string, string> = {},
): Promise<{ r: TempRepo; ids: WriteIssues }> {
  const s = await writeRepo(files);
  repos.push(s.r);
  return s;
}
async function connect(r: TempRepo, env?: NodeJS.ProcessEnv) {
  const c = await connectMcp(r, env);
  closes.push(c.close);
  return c;
}

const WRITES = [
  "issues_open",
  "issues_update",
  "issues_comment",
  "issues_start",
  "issues_stop",
  "issues_close",
];
const git = (r: TempRepo, ...args: string[]) => runGit(r, args).stdout;
const json = (x: unknown) => JSON.parse(JSON.stringify(x));

/** Calls a write tool and checks its document: `issues-write/v1` of `command`, issue as shown. */
async function write(
  r: TempRepo,
  client: Client,
  name: string,
  args: Record<string, unknown>,
  command: string,
): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError, `${name}: ${text(res)}`).toBeUndefined();
  const d = structured(res);
  expect(Object.keys(d).sort(), name).toEqual([...WRITE_KEYS]);
  expect(d, name).toMatchObject({ format: "issues-write/v1", command });
  const id = (d.issue as { id: string } | null)?.id;
  if (id !== undefined) {
    const shown = runJson<{ issue: unknown }>(r, ["show", id]).json.issue;
    expect(json(d.issue), name).toEqual(shown);
  }
  return d;
}

describe("issues mcp write tools", { timeout: 120_000 }, () => {
  it("lists the write tools after the read tools, and every write schema is strict", async () => {
    const { r } = await setup();
    const { client } = await connect(r);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const name of WRITES) expect(names).toContain(name);
    for (const t of tools.filter((x) => WRITES.includes(x.name))) {
      expect(t.annotations, t.name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      const extra = await client.callTool({ name: t.name, arguments: { id: "1", nope: 1 } });
      expect(extra.isError, t.name).toBe(true);
      expect(structured(extra), t.name).toMatchObject({
        format: "ark-error/v1",
        error: { code: "usage", message: expect.stringMatching(/^invalid input for /) },
      });
      const props = Object.keys((t.inputSchema.properties ?? {}) as object);
      for (const p of props) {
        const wrong = await client.callTool({ name: t.name, arguments: { [p]: { x: 1 } } });
        expect(wrong.isError, `${t.name}.${p}`).toBe(true);
        expect(structured(wrong), `${t.name}.${p}`).toMatchObject({
          error: { code: "usage", message: expect.stringMatching(/^invalid input for /) },
        });
      }
    }
    const update = await client.callTool({ name: "issues_update", arguments: { id: "1" } });
    expect(update.isError).toBe(true);
    expect(structured(update)).toMatchObject({
      error: {
        code: "usage",
        message: expect.stringContaining("issues_update needs id and a title or sections"),
      },
    });
  });

  it("issues_open, issues_update and issues_comment return the CLI's write documents", async () => {
    const { r, ids } = await setup();
    const { client } = await connect(r);
    const opened = await write(
      r,
      client,
      "issues_open",
      { title: "Rotate keys", sections: { goal: "Rotate them.", done: "They are rotated." } },
      "new",
    );
    expect(opened).toMatchObject({ ok: true, findings: [], commit: null });
    const id = (opened.issue as { id: string }).id;
    const draft = await write(r, client, "issues_open", { title: "Half done" }, "new");
    expect(draft.ok).toBe(true);
    const rules = (draft.findings as { rule: string }[]).map((f) => f.rule);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((x) => x.startsWith("template/"))).toBe(true);

    const updated = await write(
      r,
      client,
      "issues_update",
      { id, title: "Rotate the keys", sections: { done: "Every key is rotated." } },
      "edit",
    );
    expect(updated).toMatchObject({ ok: true, findings: [] });
    const body = await readFile(
      join(r.root, (updated.issue as { body_path: string }).body_path),
      "utf8",
    );
    expect(body).toContain("# Rotate the keys");
    expect(body).toContain("Every key is rotated.");

    const comment = await write(
      r,
      client,
      "issues_comment",
      { id: ids.d, text: "Still fine" },
      "comment",
    );
    expect(comment.ok).toBe(true);
    expect(git(r, "diff", "--cached", "--name-only")).toContain("docs/issues/events/");
  });

  it("issues_update refuses a description with unstaged changes and leaves them", async () => {
    const { r, ids } = await setup();
    const { client } = await connect(r);
    const path = runJson<{ issue: { body_path: string } }>(r, ["show", ids.e]).json.issue.body_path;
    await appendFile(join(r.root, path), "\nA person's note.\n");
    const res = await client.callTool({
      name: "issues_update",
      arguments: { id: ids.e, sections: { goal: "Dark mode." } },
    });
    expect(res.isError).toBe(true);
    expect(structured(res)).toMatchObject({
      error: {
        code: "usage",
        message: `${path} has unstaged changes; stage or discard them, or edit the description by hand`,
      },
    });
    expect(git(r, "diff", "--name-only").trim()).toBe(path);
    expect(git(r, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(join(r.root, path), "utf8")).toContain("A person's note.");
  });

  it("with auto_commit, an incomplete issues_open or issues_update is refused, nothing staged", async () => {
    const { r, ids } = await setup({ "docs/issues/issues.toml": "[policy]\nauto_commit = true\n" });
    const { client } = await connect(r);
    const status = git(r, "status", "--porcelain");
    const head = git(r, "rev-parse", "HEAD");
    const open = await client.callTool({
      name: "issues_open",
      arguments: { title: "Half done", sections: { goal: "Only the goal." } },
    });
    expect(structured(open)).toMatchObject({ ok: false, issue: null, written: [], commit: null });
    expect(text(open)).toContain("Fill in every required section and call issues_open again.");
    expect(git(r, "status", "--porcelain")).toBe(status);

    const path = runJson<{ issue: { body_path: string } }>(r, ["show", ids.e]).json.issue.body_path;
    const before = await readFile(join(r.root, path), "utf8");
    const update = await client.callTool({
      name: "issues_update",
      arguments: { id: ids.e, sections: { done: "" } },
    });
    expect(structured(update)).toMatchObject({ ok: false, written: [], commit: null });
    expect(await readFile(join(r.root, path), "utf8")).toBe(before);
    expect(git(r, "status", "--porcelain")).toBe(status);
    expect(git(r, "rev-parse", "HEAD")).toBe(head);
  });

  it("issues_start, issues_stop and issues_close return the CLI's write documents", async () => {
    const { r, ids } = await setup();
    const { client } = await connect(r);
    const started = await write(r, client, "issues_start", { id: ids.e }, "start");
    expect(started).toMatchObject({ ok: true, issue: { state: "in-progress", assignees: [ME] } });
    const stopped = await write(r, client, "issues_stop", { id: ids.e, reason: "later" }, "stop");
    expect(stopped).toMatchObject({ ok: true, issue: { state: "open" } });
    const closed = await write(
      r,
      client,
      "issues_close",
      { id: ids.g, resolution: "duplicate", of: ids.e, reason: "same work" },
      "close",
    );
    expect(closed).toMatchObject({ ok: true, affected: [{ id: ids.e }] });
  });

  it("issues_close's of and resolution must fit, named as the tool's inputs", async () => {
    const { r, ids } = await setup();
    const { client } = await connect(r);
    const of = await client.callTool({
      name: "issues_close",
      arguments: { id: ids.e, resolution: "wontfix", of: ids.a, reason: "x" },
    });
    expect(of.isError).toBe(true);
    expect(structured(of)).toMatchObject({
      error: { code: "usage", message: "of needs resolution duplicate (or no resolution)" },
    });
    const dup = await client.callTool({
      name: "issues_close",
      arguments: { id: ids.e, resolution: "duplicate", reason: "x" },
    });
    expect(structured(dup)).toMatchObject({
      error: {
        code: "usage",
        message: "resolution duplicate needs of, the issue this one duplicates",
      },
    });
    for (const res of [of, dup]) expect(text(res)).not.toContain("--");
  });

  it("issues_reopen isn't a tool: it says reopening is left to people", async () => {
    const { r, ids } = await setup();
    const { client } = await connect(r);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("issues_reopen");
    const err = await mcpError(
      client.callTool({ name: "issues_reopen", arguments: { id: ids.d, reason: "x" } }),
    );
    expect(err.code).toBe(-32602);
    expect(err.message).toContain(`issues_reopen is not available: ${REOPEN_REASON}`);
    expect(err.message).toContain("reopening is left to people");
  });

  it("lists issues_close only with mcp_can_close, and warns when close_requires_human", async () => {
    const { r, ids } = await setup({
      "docs/issues/issues.toml": "[policy]\nmcp_can_close = false\n",
    });
    const off = await connect(r);
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("issues_close");
    const err = await mcpError(
      off.client.callTool({ name: "issues_close", arguments: { id: ids.e, reason: "x" } }),
    );
    expect(err.code).toBe(-32602);
    expect(err.message).toContain(
      "issues_close is not available: [policy] mcp_can_close is false in docs/issues/issues.toml; a person closes issues with the issues CLI, or set it to true and restart issues mcp",
    );
    expect(off.stderr).toEqual([]);

    await writeFile(
      join(r.root, "docs/issues/issues.toml"),
      "[policy]\nclose_requires_human = true\n",
    );
    const human = await connect(r);
    expect((await human.client.listTools()).tools.map((t) => t.name)).toContain("issues_close");
    expect(human.stderr.join("")).toBe(
      "issues: warning: issues_close refuses agents while [policy] close_requires_human is true\n",
    );
  });

  const tableB = (repo: RowRepo, files: Record<string, string> = {}) =>
    it(`Table B: the ${repo} rows`, async () => {
      const { r, ids } = await setup(files);
      const { client } = await connect(r);
      const rows = TABLE_B.filter((x) => x.repo === repo);
      const n = await runTableB(
        (name, args) => client.callTool({ name, arguments: args }),
        ids,
        rows,
        {
          setPolicy: (toml) => writeFile(join(r.root, "docs/issues/issues.toml"), toml),
        },
      );
      expect(n).toBeGreaterThanOrEqual(rows.length * 6);
    });
  tableB("start");
  tableB("stop");
  tableB("close");
  tableB("shared");
  tableB("crh", { "docs/issues/issues.toml": "[policy]\nclose_requires_human = true\n" });
});
