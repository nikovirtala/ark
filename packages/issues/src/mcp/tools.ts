import type { JsonValue } from "@nikovirtala/ledger";
import type { McpSchema } from "@nikovirtala/ledger/mcp";
import { ASSIGNEE, LABEL } from "../kind/schemas.js";
import { ISSUE_STATES } from "../kind.js";
import { type IssueLog, openIssueLog, readIssues, readSourceIssues } from "../log.js";

/** Where `issues mcp` runs: every call opens the log afresh from here (design D2). */
export interface IssuesMcpEnv {
  readonly cwd: string;
  readonly root: string | null;
  readonly env: NodeJS.ProcessEnv;
}

/** A relation target: as `ID`, `<source>:<id>`, or a decision for `implements`. */
export const REF: McpSchema = { type: "string", minLength: 1, maxLength: 100 };
/** Labels, at most `max`. */
export const LABELS = (max = 50): McpSchema => ({
  type: "array",
  items: { type: "string", pattern: LABEL },
  maxItems: max,
});
/** Assignees; `me` is the address the server acts for. */
export const ASSIGNEES: McpSchema = {
  type: "array",
  items: { type: "string", pattern: ASSIGNEE },
  maxItems: 20,
};
export const STATES: McpSchema = {
  type: "array",
  items: { type: "string", enum: [...ISSUE_STATES] },
  uniqueItems: true,
  minItems: 1,
  maxItems: ISSUE_STATES.length,
};
/** `--limit`. */
export const LIMIT: McpSchema = { type: "integer", minimum: 1, maximum: 1000 };

/** The log for one call, opened again so outside edits and `issues.toml` changes are seen. */
export const openLog = (e: IssuesMcpEnv, ref: string | null = null): Promise<IssueLog> =>
  openIssueLog({ cwd: e.cwd, root: e.root, ref, gitOptions: { env: e.env } });

/** The local log, or with `source` that `[[sources]]` entry's cached log (never the network). */
export async function readFor(e: IssuesMcpEnv, source: string | null) {
  const log = await openLog(e);
  return {
    log,
    read: source === null ? await readIssues(log) : await readSourceIssues(log, source),
  };
}

export const int = (v: JsonValue | undefined): number | undefined =>
  typeof v === "number" ? v : undefined;
