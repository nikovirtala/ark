/**
 * The readable text of each MCP tool result (design §6.4, last column, and §7.4). The documents
 * are the CLI's; these texts are MCP's own, and their state headers point at `issues://issue/…`.
 */
import { type Finding, renderStateHeader, type StateHeader } from "@nikovirtala/ledger";
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
  RESOLUTION_WORDS,
  stateHeader,
} from "../views.js";
import type { IssueWriteJson } from "../write.js";
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

/** `<display> (<id>)`, or the id when the issue has no number. */
const named = (v: IssueView) => (v.display === v.id ? v.id : `${v.display} (${v.id})`);

const listOrNone = (xs: readonly string[]) => (xs.length === 0 ? "none" : xs.join(", "));

/** What a write's text needs besides the document. */
export interface WriteTextOptions {
  /** The log read after the write, for the header. */
  readonly read: IssuesRead;
  /** The tool, for the refusal's last line. */
  readonly tool: string;
  /** For `issues_update`: the section ids sent. */
  readonly sections?: readonly string[];
  /** For `issues_update`: whether a title was sent. */
  readonly title?: boolean;
  /** For `issues_link` and `issues_unlink`: the relation and the target sent. */
  readonly rel?: string;
  readonly to?: string;
}

const SECTION_FINDING =
  /^(?:required )?section (.+?) (is missing|is empty|still contains its guidance text)$/;

/** Template lint as `Fill in: <heading> (<message>)`, other findings as `Warning: …`. */
function findingLines(findings: readonly Finding[]): string[] {
  return findings.map((f) => {
    const m = f.rule.startsWith("template/") ? SECTION_FINDING.exec(f.message) : null;
    if (m === null) return `Warning: ${f.message} [${f.rule}]`;
    return `Fill in: ${m[1]} (${f.message})`;
  });
}

/** The hint after a refusal's findings, for the first rule that has one. */
function refusalHint(findings: readonly Finding[], tool: string): string[] {
  const rules = findings.map((f) => f.rule);
  if (rules.includes("issue/agent-closed")) {
    return [
      "The issue log's policy keeps closing to people: tell the user the issue is ready to close and how each Done when condition was met.",
    ];
  }
  if (rules.includes("issue/agent-reason-required")) {
    return [
      "Call issues_close again with a reason that says how each Done when condition was met.",
    ];
  }
  if (rules.length > 0 && rules.every((r) => r.startsWith("template/"))) {
    return [`Fill in every required section and call ${tool} again.`];
  }
  return [];
}

/** The line saying what an ok write did. */
function doneLines(doc: IssueWriteJson, v: IssueView, o: WriteTextOptions): string[] {
  const who = named(v);
  switch (doc.command) {
    case "new":
      return [`Opened ${who}: ${v.title}`, ...(v.body_path === null ? [] : [`  ${v.body_path}`])];
    case "edit":
      return [
        `Updated ${who}: ${[...(o.sections ?? []), ...(o.title === true ? ["title"] : [])].join(", ")}`,
      ];
    case "comment":
      return [`Commented on ${who}`];
    case "start":
      return [`Started ${who}`];
    case "stop":
      return [`Stopped ${who}`];
    case "close": {
      const canonical = doc.affected[0];
      const as =
        v.resolution === "duplicate"
          ? `a duplicate of ${canonical?.display ?? o.read.projection.views.get(v.duplicate_of ?? "")?.display ?? v.duplicate_of}`
          : (RESOLUTION_WORDS[v.resolution ?? "done"] ?? v.resolution);
      return [`Closed ${who} as ${as}`];
    }
    case "link":
    case "unlink": {
      const target = doc.affected[0]?.display ?? o.to ?? "";
      return [
        `${doc.command === "link" ? "Linked" : "Unlinked"} ${who} ${o.rel ?? "relates-to"} ${target}`,
      ];
    }
    case "label":
      return [`Labels of ${who}: ${listOrNone(v.labels)}`];
    case "assign":
      return [`Assignees of ${who}: ${listOrNone(v.assignees)}`];
    case "scope":
      return [`Scope of ${who}: ${listOrNone(v.applies_to)}`];
    default:
      return [`${doc.command} ${who}`];
  }
}

/**
 * A write's text (design §7.4): what was written and how it was recorded, or `Refused:` with the
 * findings and a hint; the lint findings and warnings; then the document's notes.
 */
export function writeText(doc: IssueWriteJson, o: WriteTextOptions): Text {
  const view = doc.issue === null ? null : (o.read.projection.views.get(doc.issue.id) ?? doc.issue);
  const headers = view === null ? [] : [mcpHeader(view, o.read)];
  const out: string[] = [];
  if (!doc.ok) {
    out.push(
      "Refused:",
      ...doc.findings.map(
        (f) => `  ${f.file === null ? "" : `${f.file}: `}${f.message} [${f.rule}]`,
      ),
      ...refusalHint(doc.findings, o.tool),
    );
  } else if (view !== null) {
    if (doc.written.length === 0) out.push(`Unchanged: ${named(view)}`);
    else {
      const n = doc.written.length;
      out.push(
        ...doneLines(doc, view, o),
        doc.commit === null
          ? `Staged ${n} file${n === 1 ? "" : "s"}`
          : `Committed ${doc.commit.slice(0, 7)}`,
      );
    }
    out.push(...findingLines(doc.findings));
  }
  out.push(...doc.notes.map((n) => `Note: ${n}`));
  return { headers, text: out.join("\n") };
}
