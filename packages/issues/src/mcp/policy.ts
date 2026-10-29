/**
 * What `issues mcp` lists under the issue log's close policy (design §7.3, D3, D4). The kind
 * refuses agent closes itself (ADR-0014), so this decides only listing and the startup warning.
 */
import type { IssuesConfig } from "../config.js";

export const CLOSE_TOOL = "issues_close";

/** Why `issues_reopen` isn't a tool (ADR-0014): the −32602 reason a call gets. */
export const REOPEN_REASON =
  "reopening is left to people (ADR-0014); explain with issues_comment why the issue should be reopened, and tell the user";

/**
 * Whether `issues_close` is listed (`[policy] mcp_can_close` at startup), the startup warning when
 * it is listed but `close_requires_human` refuses every agent close, and the −32602 reason when it
 * isn't listed. `configPath` is the `issues.toml` the log was opened with, if any.
 */
export function closeAvailability(
  issues: IssuesConfig,
  configPath: string | null,
): { listed: boolean; warning: string | null; reason: string | null } {
  const listed = issues.mcpCanClose;
  return {
    listed,
    warning:
      listed && issues.closeRequiresHuman
        ? "issues: warning: issues_close refuses agents while [policy] close_requires_human is true\n"
        : null,
    reason: listed
      ? null
      : `[policy] mcp_can_close is false in ${configPath ?? "issues.toml (not present)"}; a person closes issues with the issues CLI, or set it to true and restart issues mcp`,
  };
}
