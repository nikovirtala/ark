/**
 * The MCP server the generated setup configures, started the way each harness starts it (?78,
 * ?81): the config `issues init --setup` wrote, its env expanded by the harness's own rules, with
 * `ARK_ON_BEHALF_OF` unset, set, empty and left as the literal placeholder, and one write through
 * the built server. The published package the config pins is replaced by the workspace build, since
 * the build is what a release will publish.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HARNESS_RUNTIMES, HARNESSES } from "@nikovirtala/ledger";
import { repoFiles, type TempRepo } from "@nikovirtala/ledger/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI, cliEnv, cliRepo, REPO_HUMAN, requireBuilt, runIssues } from "./test-support/cli.js";

const TIMEOUT = 120_000;
const EMAIL = "niko@example.com";
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder a harness leaves
const LITERAL = "${ARK_ON_BEHALF_OF}";

/**
 * Findings of the 2026-11-14 audit this suite covers that are still open; each is expected to fail
 * until the change that fixes it removes its entry.
 */
const KNOWN_FAILING: ReadonlySet<string> = new Set<string>();
const check = (finding: string) => (KNOWN_FAILING.has(finding) ? it.fails : it);

let repo: TempRepo;
beforeAll(async () => {
  repo = await cliRepo();
  const init = runIssues(repo, ["init", "--setup", "--no-commit"]);
  expect(init.status, init.stderr).toBe(0);
}, TIMEOUT);
afterAll(async () => {
  await repo.dispose();
});

/** The write the server makes: an opened issue, attributed by `ARK_ON_BEHALF_OF` or the git identity. */
async function proposeVia(
  harness: (typeof HARNESSES)[number],
  user: Record<string, string | undefined>,
) {
  const runtime = HARNESS_RUNTIMES[harness];
  const server = runtime.mcpServers(repoFiles(repo.root)).find((s) => s.name === "issues");
  if (server === undefined) throw new Error(`${harness}: no issues server configured`);
  expect(server.command).toBe("npx");
  expect(server.args.slice(-1)).toEqual(["mcp"]);
  const configured = runtime.mcpEnv(server.env, user);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [requireBuilt(CLI), "mcp"],
    cwd: repo.root,
    // A stdio client passes only a few variables unless given env explicitly.
    env: {
      ...(cliEnv(repo) as Record<string, string>),
      ...configured,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  const client = new Client({ name: "conformance", version: "1.0.0" });
  try {
    await client.connect(transport).catch((err: unknown) => {
      throw new Error(`issues mcp did not start: ${(err as Error).message}\n${stderr}`);
    });
    const result = await client.callTool({
      name: "issues_open",
      arguments: {
        title: `Rotate keys for ${harness}`,
        sections: { goal: "Rotate the signing keys.", done: "Every key is rotated." },
      },
    });
    const doc = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    return { doc, stderr, isError: (result as { isError?: boolean }).isError === true };
  } finally {
    await client.close();
  }
}

describe.each(HARNESSES)("%s: issues mcp as the harness starts it", (harness) => {
  it(
    "writes with ARK_ON_BEHALF_OF set",
    async () => {
      const r = await proposeVia(harness, { ARK_ON_BEHALF_OF: EMAIL });
      expect(r.isError).toBe(false);
      expect(r.doc).toMatchObject({ ok: true });
      expect(r.doc.notes).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "writes with ARK_ON_BEHALF_OF empty, on behalf of the git identity, with a note",
    async () => {
      const r = await proposeVia(harness, { ARK_ON_BEHALF_OF: "" });
      expect(r.doc).toMatchObject({ ok: true });
      expect(JSON.stringify(r.doc.notes)).toContain(REPO_HUMAN.email ?? "");
    },
    TIMEOUT,
  );

  check("78")(
    "writes with ARK_ON_BEHALF_OF unset, on behalf of the git identity, with a note",
    async () => {
      const r = await proposeVia(harness, {});
      expect(r.isError).toBe(false);
      expect(r.doc).toMatchObject({ ok: true });
      expect(JSON.stringify(r.doc.notes)).toContain(REPO_HUMAN.email ?? "");
    },
    TIMEOUT,
  );

  check("78")(
    "writes when the harness leaves the literal placeholder, and names the setting that fixes it",
    async () => {
      const server = HARNESS_RUNTIMES[harness]
        .mcpServers(repoFiles(repo.root))
        .find((s) => s.name === "issues");
      expect(server).toBeDefined();
      // What an unapproved Kiro variable, or an unset one with no default, hands the server.
      const r = await proposeVia(harness, { ARK_ON_BEHALF_OF: LITERAL });
      expect(r.isError).toBe(false);
      expect(r.doc).toMatchObject({ ok: true });
      expect(JSON.stringify(r.doc.notes)).toContain("unexpanded placeholder");
    },
    TIMEOUT,
  );
});
