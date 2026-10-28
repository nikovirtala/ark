/**
 * The readable text of each MCP tool result (design §6.4, last column). The documents are the
 * CLI's; these texts are MCP's own, and their state headers point at `issues://issue/…`.
 */
import { renderStateHeader, type StateHeader } from "@nikovirtala/ledger";
import type { McpToolResult } from "@nikovirtala/ledger/mcp";
import type { IssueView } from "../kind.js";
import type { IssuesRead } from "../log.js";
import type { IssuesForJson } from "../scope.js";
import type { IssueSearchJson } from "../search.js";
import type { IssueTemplatesJson } from "../templates/list.js";
import {
  type IssueListJson,
  type IssueReadyJson,
  type IssueShowJson,
  stateHeader,
} from "../views.js";
import { issueUri } from "./resources.js";

type Text = Omit<McpToolResult, "document">;

const day = (at: string | null) => (at ?? "").slice(0, 10);

/** The issue's state header with MCP's `issues://issue/…` references. */
export function mcpHeader(view: IssueView, read: IssuesRead): StateHeader {
  return stateHeader(view, read, { refer: issueUri(read) });
}

/** One issue on one line, as `issues list` prints it: display, state, title and labels. */
export function issueLine(v: IssueView): string {
  const state =
    v.state === "closed" && v.resolution !== null && v.resolution !== "done"
      ? `closed (${v.resolution})`
      : v.blocked
        ? `${v.state}, blocked`
        : v.state;
  const labels = v.labels.length === 0 ? "" : `  [${v.labels.join(", ")}]`;
  return `${v.display.padEnd(10)} ${state.padEnd(16)} ${v.title}${labels}`;
}

const closedLine = (k: number) =>
  k === 1 ? "1 closed issue also matches" : `${k} closed issues also match`;

/** `issues_search`: each result's header, title and excerpt, then the counts. */
export function searchText(doc: IssueSearchJson, read: IssuesRead): Text {
  const more =
    doc.closed_omitted > 0 ? [`${closedLine(doc.closed_omitted)}; pass include_closed`] : [];
  if (doc.results.length === 0) {
    const none = doc.include_closed ? "No issues match." : "No open issues match.";
    return { headers: [], text: [none, ...more].join("\n") };
  }
  const lines: string[] = [];
  for (const r of doc.results) {
    const view = read.projection.views.get(r.issue.id) ?? r.issue;
    lines.push(renderStateHeader(mcpHeader(view, read)).trimEnd());
    lines.push(`  ${r.issue.title}`);
    const where = r.matched.filter((f) => f === "id" || f === "title").join(" and ");
    lines.push(r.excerpt === null ? `  (${where} match)` : `  ${r.excerpt}`);
  }
  lines.push(`${doc.results.length} of ${doc.total} shown`, ...more);
  return { headers: [], text: lines.join("\n") };
}

/**
 * `issues_get`: the header, then what `issues show` prints after it: the facts line, the
 * description, relations, comments and history.
 */
export function getText(doc: IssueShowJson, read: IssuesRead): Text {
  const v = doc.issue;
  const out: string[] = [
    [
      `opened ${day(v.opened_at)}`,
      ...(v.assignees.length === 0 ? [] : [`assigned to ${v.assignees.join(", ")}`]),
      ...(v.labels.length === 0 ? [] : [`labels ${v.labels.join(", ")}`]),
      ...(v.applies_to.length === 0 ? [] : [`scope ${v.applies_to.join(", ")}`]),
    ].join(" · "),
    "",
    doc.body === null ? "(no description file)" : doc.body.trimEnd(),
    "",
  ];
  if (doc.references.length > 0) {
    out.push("Relations:");
    for (const r of doc.references) {
      const what = [r.title, r.status === null ? null : `(${r.status})`].filter((x) => x !== null);
      const unchecked = r.checked ? "" : " (not checked)";
      out.push(
        `  ${r.rel.padEnd(12)} ${r.display}${what.length === 0 ? "" : ` ${what.join(" ")}`}${unchecked}`,
      );
    }
    out.push("");
  }
  if (doc.comments !== null && doc.comments.length > 0) {
    out.push("Comments:");
    for (const c of doc.comments) {
      const who =
        c.actor.kind === "agent" ? `${c.actor.agent ?? c.actor.name} (agent)` : c.actor.name;
      out.push(`  ${day(c.at)} ${who}:`, ...c.text.split("\n").map((l) => `    ${l}`));
    }
    out.push("");
  }
  if (doc.events !== null) {
    out.push("History:");
    for (const e of doc.events) {
      const reason = typeof e.reason === "string" ? `: ${e.reason}` : "";
      out.push(`  ${e.at} ${e.type} by ${e.actor.name}${reason}`);
    }
    out.push("");
  }
  return { headers: [mcpHeader(v, read)], text: out.join("\n").trimEnd() };
}

const lines = (views: readonly IssueView[], none: string): Text => ({
  headers: [],
  text: views.length === 0 ? none : views.map(issueLine).join("\n"),
});

/** `issues_list`: one line per issue. */
export const listText = (doc: IssueListJson): Text => lines(doc.issues, "No issues.");

/** `issues_ready`: one line per issue, in ready order. */
export const readyText = (doc: IssueReadyJson): Text => lines(doc.issues, "No ready issues.");

/** `issues_for_path`: per path, each issue with how it matched and its header's warning. */
export function forText(doc: IssuesForJson, read: IssuesRead): Text {
  const out: string[] = [];
  for (const p of doc.paths) {
    out.push(`${p.path}${p.tracked ? "" : " (untracked)"}`);
    if (p.issues.length === 0 && p.unresolved.length === 0) out.push("  no issues");
    for (const i of p.issues) {
      const via = i.via.map((x) => (x.type === "glob" ? x.glob : `line ${x.line}`)).join(", ");
      out.push(`  ${i.display} ${i.state} ${i.title} (via ${via})`);
      const view = read.projection.views.get(i.id);
      const warning = view === undefined ? i.warning : mcpHeader(view, read).warning;
      if (warning !== null) out.push(`    ${warning}`);
    }
    for (const u of p.unresolved) {
      const why = u.reason === "other-log" ? "in another log" : "not in this log";
      out.push(`  unresolved: ${u.ref} (line ${u.line}, ${why})`);
    }
  }
  return { headers: [], text: out.join("\n") };
}

/** `issues_templates`: each template, then its sections. */
export function templatesText(doc: IssueTemplatesJson): Text {
  const out = doc.templates.flatMap((t) => [
    `${t.name} v${t.version} (${t.source})${t.name === doc.default ? " default" : ""}`,
    ...t.sections.map(
      (s) =>
        `  ${s.id}: ${s.heading} (${s.required ? "required" : "optional"})${s.guidance === null ? "" : ` — ${s.guidance}`}`,
    ),
  ]);
  return { headers: [], text: out.length === 0 ? "No templates." : out.join("\n") };
}
