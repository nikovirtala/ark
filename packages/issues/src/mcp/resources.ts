import { resolveSubjectInput } from "@nikovirtala/ledger";
import {
  checkResourceId,
  type McpResource,
  type McpResourceTemplate,
} from "@nikovirtala/ledger/mcp";
import { issueKind } from "../kind.js";
import { type IssuesRead, readIssues, resolveIssue } from "../log.js";
import { renderIssueIndexText } from "../log-index.js";
import { readyIssues, showIssue } from "../views.js";
import { mcpHeader } from "./text.js";
import { type IssuesMcpEnv, openLog } from "./tools.js";

/**
 * Where an MCP client reads an issue: `issues://issue/17` when numbered (the bare number, since a
 * `?` would start the URI's query), else `issues://issue/<id>`. The `refer` of every MCP header.
 */
export function issueUri(read: IssuesRead): (id: string) => string {
  return (id) => {
    const n = read.projection.views.get(id)?.number ?? null;
    return `issues://issue/${n === null ? id : n}`;
  };
}

/** `issues://index`: the index table, numbered like every other read (design §6.6). */
export function indexResource(e: IssuesMcpEnv): McpResource {
  return {
    uri: "issues://index",
    name: "index",
    title: "Issue index",
    description:
      "All issues, grouped and ordered as in index.md: in progress, ready, blocked, other open, recently closed",
    mimeType: "text/markdown",
    async read() {
      return { header: null, text: renderIssueIndexText(await readIssues(await openLog(e))) };
    },
  };
}

/** `issues://ready`: `issues ready` without filters, as a markdown list. */
export function readyResource(e: IssuesMcpEnv): McpResource {
  return {
    uri: "issues://ready",
    name: "ready",
    title: "Ready issues",
    description: "The ready list: what can be picked up now, highest priority first",
    mimeType: "text/markdown",
    async read() {
      const doc = readyIssues(await readIssues(await openLog(e)));
      const lines = doc.issues.map((v) => {
        const head = v.number === null ? v.id : `${v.display} (${v.id})`;
        const labels = v.labels.length === 0 ? "" : ` [${v.labels.join(", ")}]`;
        return `- ${head} ${v.title}${labels}`;
      });
      const body = lines.length === 0 ? "No ready issues." : lines.join("\n");
      return { header: null, text: `# Ready issues\n\n${body}\n` };
    },
  };
}

/**
 * `issues://issue/{id}`: the issue's state header, then its description. `{id}` is the id, the
 * number (`4`, `0004`) or `%3F4` (a literal `?` starts the URI's query); an unknown one is not
 * found, a malformed or qualified one is the caller's error.
 */
export function issueResource(e: IssuesMcpEnv): McpResourceTemplate {
  return {
    uriTemplate: "issues://issue/{id}",
    name: "issue",
    title: "Issue",
    description:
      "One issue: its state header, then its description. {id} is the id (6930v8w9), the number (4), or %3F4 for ?4",
    mimeType: "text/markdown",
    async read({ id = "" }) {
      checkResourceId(id, "issue");
      const read = await readIssues(await openLog(e));
      const r = resolveSubjectInput(id, {
        subjects: new Set(read.folded.subjects.keys()),
        kind: issueKind,
        numbering: read.numbering,
      });
      if (!r.ok && r.reason === "not-found") return null;
      const doc = showIssue(read, resolveIssue(read, id), { comments: false });
      return {
        header: mcpHeader(doc.issue, read),
        text: doc.body === null ? "(no description file)\n" : doc.body,
      };
    },
  };
}
