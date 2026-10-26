import { parseOnBehalfOf } from "@nikovirtala/ledger";
import { type McpServeOptions, serveMcp } from "@nikovirtala/ledger/mcp";
import { openDecisionLog } from "../log.js";
import { DECISION_TOOLS, decisionToolsAvailable } from "./policy.js";
import { type AdrMcpEnv, alwaysOnTools, decisionTools } from "./tools.js";

export const INSTRUCTIONS =
  "Architecture decisions in this repository are managed by adr. Decision files don't show their status: read decisions with adr_get or adr://decision/{id}, check adr_for_path and adr_search before changing architecture, and propose changes with adr_propose; a human accepts them.";

/**
 * `adr mcp` (design §7.2): checks `ARK_ON_BEHALF_OF` and opens the log first, so a bad
 * environment exits 2 before serving, then serves adr's tools over stdio until the client goes.
 */
export async function serveAdrMcp(o: {
  readonly cwd: string;
  readonly root: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly stderr: { write(s: string): void };
  readonly transport?: McpServeOptions["transport"];
}): Promise<void> {
  parseOnBehalfOf(o.env.ARK_ON_BEHALF_OF);
  const log = await openDecisionLog({ cwd: o.cwd, root: o.root, gitOptions: { env: o.env } });
  const e: AdrMcpEnv = { cwd: o.cwd, root: o.root, env: o.env };
  const decide = decisionToolsAvailable(log.adr);
  const tools = [...alwaysOnTools(e), ...(decide ? decisionTools(e) : [])];
  const unavailable: Record<string, string> = {};
  if (decide && log.adr.acceptRequiresHuman) {
    o.stderr.write(
      "adr: warning: adr_accept refuses agents while [policy] accept_requires_human is true\n",
    );
  }
  if (!decide) {
    const where = log.configPath ?? "adr.toml (not present)";
    for (const name of DECISION_TOOLS) {
      unavailable[name] =
        `[policy] mcp_can_decide is false in ${where}; a human decides with the adr CLI, or set it to true and restart adr mcp`;
    }
  }
  await serveMcp(
    { name: "adr", version: o.version, instructions: INSTRUCTIONS, tools, unavailable },
    {
      env: o.env,
      stderr: o.stderr,
      ...(o.transport === undefined ? {} : { transport: o.transport }),
    },
  );
}
