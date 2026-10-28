import { parseOnBehalfOf } from "@nikovirtala/ledger";
import { type McpServeOptions, serveMcp } from "@nikovirtala/ledger/mcp";
import { openIssueLog } from "../log.js";
import { readTools } from "./read-tools.js";
import type { IssuesMcpEnv } from "./tools.js";

export const INSTRUCTIONS =
  "Issues in this repository are tracked with issues. Issue files don't show their state: read issues with issues_get or issues://issue/{id}, find work with issues_ready, issues_search and issues_for_path.";

/**
 * `issues mcp` (design §4.2): checks `ARK_ON_BEHALF_OF` and opens the log first, so a bad
 * environment exits 2 before serving, then serves issues' tools over stdio until the client goes.
 */
export async function serveIssuesMcp(o: {
  readonly cwd: string;
  readonly root: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
  readonly stderr: { write(s: string): void };
  readonly transport?: McpServeOptions["transport"];
}): Promise<void> {
  parseOnBehalfOf(o.env.ARK_ON_BEHALF_OF);
  await openIssueLog({ cwd: o.cwd, root: o.root, gitOptions: { env: o.env } });
  const e: IssuesMcpEnv = { cwd: o.cwd, root: o.root, env: o.env };
  await serveMcp(
    {
      name: "issues",
      version: o.version,
      instructions: INSTRUCTIONS,
      tools: readTools(e),
    },
    {
      env: o.env,
      stderr: o.stderr,
      ...(o.transport === undefined ? {} : { transport: o.transport }),
    },
  );
}
