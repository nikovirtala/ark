/**
 * Shared helpers for the end-to-end tests of the BUILT `issues mcp` over real stdio
 * (`mcp-e2e.read.test.ts`, `mcp-e2e.write.test.ts` and `mcp-e2e.table-b.test.ts`): start the
 * server with the MCP SDK's stdio client, call its tools, and check what a write recorded.
 */
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { expect } from "vitest";
import { CLI, cliEnv, requireBuilt, runGit, WRITE_KEYS } from "./cli.js";
import { cli } from "./mcp.js";

export const TIMEOUT = 120_000;

export interface Session {
  readonly client: Client;
  readonly stderr: () => string;
  readonly exit: Promise<number | null>;
  close(): Promise<number | null>;
}

/** Starts the built `issues mcp` in `repo` with the SDK's stdio client, named `e2e-agent`. */
export function spawnMcp(repo: TempRepo, env: NodeJS.ProcessEnv, clientName = "e2e-agent") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [requireBuilt(CLI), "mcp"],
    cwd: repo.root,
    // P7: a stdio client passes only a few variables unless given env explicitly.
    env: cliEnv(repo, env) as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const client = new Client({ name: clientName, version: "1.0.0" });
  return { transport, client, stderr: () => stderr };
}

/** The exit code of the transport's child process, once it has started. */
export function exitOf(transport: StdioClientTransport): Promise<number | null> {
  // The SDK keeps the child private; its exit code is what `issues mcp` returns.
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  return new Promise((resolve) => {
    if (child === undefined) resolve(null);
    else if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

export async function startMcp(
  repo: TempRepo,
  env: NodeJS.ProcessEnv = {},
  clientName?: string,
): Promise<Session> {
  const { transport, client, stderr } = spawnMcp(repo, env, clientName);
  await client.connect(transport);
  const exit = exitOf(transport);
  return {
    client,
    stderr,
    exit,
    async close() {
      await client.close();
      return exit;
    },
  };
}

export const call = (s: Session, name: string, args: Record<string, unknown> = {}) =>
  s.client.callTool({ name, arguments: args });
export const doc = (r: unknown) =>
  (r as { structuredContent: Record<string, unknown> }).structuredContent;
export const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
export const read = async (s: Session, uri: string) =>
  ((await s.client.readResource({ uri })).contents[0] as { text: string }).text;

export const READ_NAMES = [
  "issues_search",
  "issues_get",
  "issues_list",
  "issues_ready",
  "issues_for_path",
  "issues_templates",
];
export const WRITE_NAMES = [
  "issues_open",
  "issues_update",
  "issues_comment",
  "issues_start",
  "issues_stop",
  "issues_close",
  "issues_link",
  "issues_unlink",
  "issues_label",
  "issues_assign",
  "issues_scope",
];
export const ALL_NAMES = [...READ_NAMES, ...WRITE_NAMES];
export const WITHOUT_CLOSE = ALL_NAMES.filter((n) => n !== "issues_close");
export const CONFIG = "docs/issues/issues.toml";
export const TASK = { goal: "Rotate the signing keys.", done: "Every key is rotated." };
export const REASON = "Done when is met: the test checked it.";
export const STARTUP_WARNING =
  "issues: warning: issues_close refuses agents while [policy] close_requires_human is true\n";
export const NO_IDENTITY = {
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export type WriteDoc = {
  ok: boolean;
  command: string;
  issue: { id: string; state: string; assignees: string[]; labels: string[] } | null;
  affected: { id: string }[];
  written: string[];
  commit: string | null;
  findings: { rule: string; message: string }[];
  notes: string[];
};

export const names = async (s: Session) => (await s.client.listTools()).tools.map((t) => t.name);
export const rules = (d: WriteDoc) => d.findings.map((f) => f.rule);
export const git = (r: TempRepo, ...args: string[]) => {
  const out = runGit(r, args);
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout;
};
export const lastEvent = (r: TempRepo, id: string) => {
  const shown = JSON.parse(cli(r, ["show", id, "--history", "--json"])) as {
    events: { type: string; actor: Record<string, unknown> }[];
  };
  return shown.events.at(-1);
};

/** A write tool's call, checked to be an `issues-write/v1` result of `command` (not `isError`). */
export async function write(
  s: Session,
  name: string,
  args: Record<string, unknown>,
  command: string,
): Promise<WriteDoc & { text: string }> {
  const res = await call(s, name, args);
  expect(res.isError, `${name}: ${text(res)}`).toBeUndefined();
  const d = doc(res);
  expect(Object.keys(d).sort(), name).toEqual([...WRITE_KEYS]);
  expect(d, name).toMatchObject({ format: "issues-write/v1", command });
  return { ...(d as unknown as WriteDoc), text: text(res) };
}

export async function setPolicy(r: TempRepo, toml: string, commit = false): Promise<void> {
  await writeFile(join(r.root, CONFIG), toml);
  if (commit) {
    git(r, "add", CONFIG);
    git(r, "commit", "-qm", "chore: set the issue log's policy");
  }
}
