/** Test-only helpers for `issues mcp`: an in-memory client and a repository in every state. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { GIT_ENV_ISOLATION } from "@nikovirtala/ledger";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { serveIssuesMcp } from "../mcp/server.js";
import { cliRepo, newIssue, runIssues } from "./cli.js";

export const ME = "niko@example.com";

/** `issues mcp` served over an in-memory transport to an SDK client; `close` ends both. */
export async function connectMcp(
  r: TempRepo,
  env: NodeJS.ProcessEnv = { ARK_ON_BEHALF_OF: ME },
): Promise<{ client: Client; stderr: string[]; close(): Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const stderr: string[] = [];
  // An `undefined` in `env` removes that variable.
  const merged: NodeJS.ProcessEnv = { ...r.env, ...env };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const served = serveIssuesMcp({
    cwd: r.root,
    root: null,
    // git merges this over `process.env`, so a deleted GIT_DIR would come back from it.
    env: { ...merged, ...GIT_ENV_ISOLATION },
    version: "0.0.0-test",
    stderr: { write: (s) => void stderr.push(s) },
    transport: serverSide,
  });
  const client = new Client({ name: "mcp-test", version: "1" });
  await client.connect(clientSide);
  return {
    client,
    stderr,
    async close() {
      await client.close();
      await served;
    },
  };
}

/** The issues of `mcpRepo`, by letter. */
export interface McpIssues {
  /** ?1 "Login fails on Safari": in progress, scoped to `src/auth/**`. */
  readonly a: string;
  /** ?2 "Safari login loops": closed as a duplicate of ?1. */
  readonly b: string;
  /** ?3 "Cache sessions": depends on ?1, so blocked. */
  readonly c: string;
  /** ?4 "Old Safari workaround": commented "Safari 16 only", closed done. */
  readonly d: string;
  /** ?5 "Add dark mode": labeled `type:feature`, ready. */
  readonly e: string;
}

/** Runs the built CLI in `r`, throwing on a non-zero exit. */
export function cli(r: TempRepo, args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  const out = runIssues(r, args, { env });
  if (out.status !== 0) throw new Error(`issues ${args.join(" ")}: ${out.stderr}`);
  return out.stdout;
}

/** A temp repository whose issues are in every state the read tools show (design §6.9). */
export async function mcpRepo(
  files: Readonly<Record<string, string>> = {},
): Promise<{ r: TempRepo; ids: McpIssues }> {
  const r = await cliRepo({ "src/auth/session.ts": "export {};\n", ...files });
  const a = newIssue(r, "Login fails on Safari");
  cli(r, ["scope", a, "--set", "src/auth/**", "--commit"]);
  cli(r, ["start", a, "--commit"]);
  const b = newIssue(r, "Safari login loops");
  cli(r, ["close", b, "--duplicate-of", a, "--reason", "same cookie bug", "--commit"]);
  const c = newIssue(r, "Cache sessions", ["--depends-on", a]);
  const d = newIssue(r, "Old Safari workaround");
  cli(r, ["comment", d, "Safari 16 only", "--commit"]);
  cli(r, ["close", d, "--reason", "dropped Safari 16", "--commit"]);
  const e = newIssue(r, "Add dark mode", ["--label", "type:feature"]);
  return { r, ids: { a, b, c, d, e } };
}

/** The issues of `writeRepo`: `mcpRepo`'s, and three more. */
export interface WriteIssues extends McpIssues {
  /** ?6 "Drop IE11 support": closed as wontfix, "no users left". */
  readonly f: string;
  /** ?7 "Split the auth module": open, the parent of ?8. */
  readonly g: string;
  /** ?8 "Move session code": open, part of ?7. */
  readonly h: string;
  /** ?9 "Release the login fix": depends on ?3 and ?5, so blocked. */
  readonly i: string;
}

/**
 * `mcpRepo` with an issue in every state the write tools distinguish (design §7.3): open (e),
 * open and blocked (c), in progress (a), closed done (d), closed wontfix (f), closed duplicate
 * (b), and open with an open child (g); i depends on c and e, so closing either as a duplicate
 * of i folds a dependency onto i (a cycle).
 */
export async function writeRepo(
  files: Readonly<Record<string, string>> = {},
): Promise<{ r: TempRepo; ids: WriteIssues }> {
  const { r, ids } = await mcpRepo(files);
  const f = newIssue(r, "Drop IE11 support");
  cli(r, ["close", f, "--resolution", "wontfix", "--reason", "no users left", "--commit"]);
  const g = newIssue(r, "Split the auth module");
  const h = newIssue(r, "Move session code", ["--parent", g]);
  const i = newIssue(r, "Release the login fix", ["--depends-on", ids.c, "--depends-on", ids.e]);
  return { r, ids: { ...ids, f, g, h, i } };
}

/** The `McpError` `p` rejects with. */
export async function mcpError(p: Promise<unknown>): Promise<McpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof McpError)) throw new Error(`expected an McpError, got ${String(err)}`);
  return err;
}

export const structured = (r: unknown) =>
  (r as { structuredContent: Record<string, unknown> }).structuredContent;
export const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
