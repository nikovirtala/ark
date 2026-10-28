import { type McpContext, type McpTool, mcpAttribution } from "@nikovirtala/ledger/mcp";
import type { IssueStatus } from "../kind.js";
import { type IssueLog, readIssues, resolveIssue } from "../log.js";
import { searchIssues } from "../search.js";
import { listIssues, myAddress, showIssue } from "../views.js";
import { getText, listText, searchText } from "./text.js";
import {
  ASSIGNEES,
  doc,
  ID,
  type IssuesMcpEnv,
  int,
  LABELS,
  LIMIT,
  object,
  openLog,
  READ,
  readFor,
  SOURCE,
  STATES,
  str,
  strings,
} from "./tools.js";

/** The address `me` stands for: the person the MCP client acts for (design §4.3). */
async function me(log: IssueLog, ctx: McpContext, name: string): Promise<string> {
  return myAddress((await mcpAttribution(log.git, ctx)).actor, name);
}

/** The read tools `issues mcp` lists (design §6.4). */
export function readTools(e: IssuesMcpEnv): McpTool[] {
  return [
    {
      name: "issues_search",
      title: "Search issues",
      description:
        "Full-text search of the issue log: every word must appear in an issue's id, number, title, description or comments, ignoring case and accents. Returns open and in-progress issues unless include_closed is true, each with its state header and an excerpt. Search before opening an issue, so you don't file a duplicate. With source, searches that [[sources]] log as last fetched.",
      inputSchema: object(
        {
          query: { type: "string", minLength: 1, maxLength: 200 },
          include_closed: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          source: SOURCE,
        },
        ["query"],
      ),
      annotations: READ,
      async run(input) {
        const { read } = await readFor(e, str(input.source) ?? null);
        const d = searchIssues(read, {
          query: str(input.query) ?? "",
          includeClosed: input.include_closed === true,
          limit: int(input.limit) ?? 10,
        });
        return { document: doc(d), ...searchText(d, read) };
      },
    },
    {
      name: "issues_get",
      title: "Get an issue",
      description:
        "One issue: its state header, computed state, relations, blockers, canonical issue, description and comments. Use this or issues://issue/{id} instead of reading files under the issue log. A DUPLICATE header names the issue to work on instead; a BLOCKED header lists what must be finished first.",
      inputSchema: object(
        {
          id: ID,
          include_history: { type: "boolean" },
          include_comments: { type: "boolean" },
          ref: { type: "string", minLength: 1, maxLength: 256 },
        },
        ["id"],
      ),
      annotations: READ,
      async run(input) {
        const read = await readIssues(await openLog(e, str(input.ref) ?? null));
        const id = resolveIssue(read, str(input.id) ?? "");
        const d = showIssue(read, id, {
          history: input.include_history === true,
          comments: input.include_comments !== false,
        });
        return { document: doc(d), ...getText(d, read) };
      },
    },
    {
      name: "issues_list",
      title: "List issues",
      description:
        'Issues with their computed state, for orientation: open and in-progress ones unless state says otherwise. Filters are AND-ed; assignee "me" is the person you act for. With source, lists that [[sources]] log as last fetched.',
      inputSchema: object({
        state: STATES,
        label: LABELS(20),
        assignee: ASSIGNEES,
        limit: LIMIT,
        source: SOURCE,
      }),
      annotations: READ,
      async run(input, ctx) {
        const { log, read } = await readFor(e, str(input.source) ?? null);
        let assignees = strings(input.assignee) ?? [];
        if (assignees.includes("me")) {
          const address = await me(log, ctx, 'assignee "me"');
          assignees = assignees.map((a) => (a === "me" ? address : a));
        }
        const d = listIssues(read, {
          states: (strings(input.state) ?? []) as IssueStatus[],
          assignees,
          labels: strings(input.label) ?? [],
          limit: int(input.limit) ?? null,
        });
        return { document: doc(d), ...listText(d) };
      },
    },
  ];
}
