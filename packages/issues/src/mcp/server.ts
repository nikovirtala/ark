import { parseOnBehalfOf } from "@nikovirtala/ledger";
import { type McpServeOptions, serveMcp } from "@nikovirtala/ledger/mcp";
import type { IssuesConfig } from "../config.js";
import { openIssueLog } from "../log.js";
import { CLOSE_TOOL, closeAvailability, REOPEN_REASON } from "./policy.js";
import { readTools } from "./read-tools.js";
import { indexResource, issueResource, readyResource } from "./resources.js";
import type { IssuesMcpEnv } from "./tools.js";
import { writeTools } from "./write-tools.js";

export const INSTRUCTIONS =
  "Issues in this repository are tracked with issues. Issue files don't show their state: read issues with issues_get or issues://issue/{id}, find work with issues_ready, issues_search and issues_for_path, start it with issues_start, and record progress with issues_comment. Close an issue only when every Done when condition is met, with a reason saying how.";

const READ_TOOLS = [
  "issues_search",
  "issues_get",
  "issues_list",
  "issues_ready",
  "issues_for_path",
  "issues_templates",
];
const WRITE_TOOLS = [
  "issues_open",
  "issues_update",
  "issues_comment",
  "issues_start",
  "issues_stop",
  CLOSE_TOOL,
];

/** The tools `issues mcp` lists, in order: `issues_close` only when `[policy] mcp_can_close`. */
export function toolNames(issues: IssuesConfig): string[] {
  const listed = closeAvailability(issues, null).listed;
  return [...READ_TOOLS, ...WRITE_TOOLS.filter((t) => t !== CLOSE_TOOL || listed)];
}

/**
 * `issues mcp` (design §4.2): checks `ARK_ON_BEHALF_OF` and opens the log first, so a bad
 * environment exits 2 before serving, then serves issues' tools over stdio until the client goes.
 * The tool list is fixed here, from the close policy at startup (design §7.3).
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
  const log = await openIssueLog({ cwd: o.cwd, root: o.root, gitOptions: { env: o.env } });
  const e: IssuesMcpEnv = { cwd: o.cwd, root: o.root, env: o.env };
  const close = closeAvailability(log.issues, log.configPath);
  const names = toolNames(log.issues);
  const tools = [...readTools(e), ...writeTools(e)].filter((t) => names.includes(t.name));
  const unavailable: Record<string, string> = {
    issues_reopen: REOPEN_REASON,
    ...(close.reason === null ? {} : { [CLOSE_TOOL]: close.reason }),
  };
  if (close.warning !== null) o.stderr.write(close.warning);
  await serveMcp(
    {
      name: "issues",
      version: o.version,
      instructions: INSTRUCTIONS,
      tools,
      unavailable,
      resources: [indexResource(e), readyResource(e)],
      resourceTemplates: [issueResource(e)],
    },
    {
      env: o.env,
      stderr: o.stderr,
      ...(o.transport === undefined ? {} : { transport: o.transport }),
    },
  );
}
