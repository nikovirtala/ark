/**
 * The readable text of each MCP tool result (design §7.4, last column). The documents are the
 * CLI's; these texts are MCP's own, and their state headers point at `adr://decision/…`.
 */
import {
  type EventEnvelope,
  type Finding,
  renderStateHeader,
  type StateHeader,
} from "@nikovirtala/ledger";
import type { McpToolResult } from "@nikovirtala/ledger/mcp";
import type { DecisionView } from "../kind.js";
import type { DecisionsRead } from "../log.js";
import type { DecisionsForJson } from "../scope.js";
import type { DecisionSearchJson } from "../search.js";
import type { TemplatesJson } from "../templates/list.js";
import { type DecisionListJson, type DecisionShowJson, stateHeader } from "../views.js";
import type { WriteResultJson } from "../write.js";
import { decisionUri } from "./resources.js";

type Text = Omit<McpToolResult, "document">;

const display = (read: DecisionsRead) => (id: string) =>
  read.projection.views.get(id)?.display ?? id;

function named(read: DecisionsRead, id: string): string {
  const shown = display(read)(id);
  return shown === id ? id : `${shown} (${id})`;
}

/** The decision's state header with MCP's `adr://` references. */
export function mcpHeader(view: DecisionView, read: DecisionsRead): StateHeader {
  return stateHeader(view, read, { refer: decisionUri(read) });
}

/** `adr_search`: each result's header, title and excerpt, then the counts. */
export function searchText(doc: DecisionSearchJson, read: DecisionsRead): Text {
  if (doc.results.length === 0) {
    const more =
      doc.inactive_omitted > 0
        ? [`${inactiveLine(doc.inactive_omitted)}; pass include_inactive`]
        : [];
    return { headers: [], text: ["No decisions match.", ...more].join("\n") };
  }
  const lines: string[] = [];
  for (const r of doc.results) {
    lines.push(renderStateHeader(mcpHeader(r.decision, read)).trimEnd());
    lines.push(`  ${r.decision.title}`);
    const where = r.matched.filter((f) => f === "id" || f === "title").join(" and ");
    lines.push(r.excerpt === null ? `  (${where} match)` : `  ${r.excerpt}`);
  }
  lines.push(`${doc.results.length} of ${doc.total} shown`);
  if (doc.inactive_omitted > 0) {
    lines.push(`${inactiveLine(doc.inactive_omitted)}; pass include_inactive`);
  }
  return { headers: [], text: lines.join("\n") };
}

const inactiveLine = (k: number) =>
  k === 1 ? "1 inactive decision also matches" : `${k} inactive decisions also match`;

function listOf(read: DecisionsRead, ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.map((id) => named(read, id)).join(", ");
}

function historyLines(events: readonly EventEnvelope[]): string[] {
  return events.map((e) => {
    const a = e.actor;
    const who = a.kind === "agent" ? `${a.name} (agent for ${a.on_behalf_of})` : a.name;
    const why = typeof e.reason === "string" ? ` — ${e.reason}` : "";
    return `  ${e.at}  ${e.type}  ${who}${why}`;
  });
}

/** `adr_get`: the header, the decision's fields as `adr show` lists them, then the body. */
export function getText(doc: DecisionShowJson, read: DecisionsRead): Text {
  const v = doc.decision;
  const lines = [
    `Title: ${v.title}`,
    `Status: ${v.status} (${v.status_at.slice(0, 10)})`,
    `Effective: ${v.effective === null ? "none (supersession cycle)" : named(read, v.effective)}`,
    `Chain: ${v.chain.map(display(read)).join(" → ")}`,
    `Supersedes: ${listOf(read, v.supersedes)}`,
    `Applies to: ${v.applies_to.length === 0 ? "no globs recorded" : v.applies_to.join(", ")}`,
  ];
  if (doc.events !== null) lines.push("History:", ...historyLines(doc.events));
  lines.push("", doc.body === null ? "(no body file)" : doc.body.trimEnd());
  return { headers: [mcpHeader(v, read)], text: lines.join("\n") };
}

/** `adr_list`: one line per decision. */
export function listText(doc: DecisionListJson, read: DecisionsRead): Text {
  if (doc.decisions.length === 0) return { headers: [], text: "No decisions." };
  const lines = doc.decisions.map((v) => {
    const head = v.number === null ? v.id : `${v.display} (${v.id})`;
    const to =
      v.effective !== null && v.effective !== v.id ? ` → ${display(read)(v.effective)}` : "";
    return `${head} · ${v.status} · ${v.title}${to}`;
  });
  return { headers: [], text: lines.join("\n") };
}

/** `adr_templates`: each template, then its sections. */
export function templatesText(doc: TemplatesJson): Text {
  const lines = doc.templates.flatMap((t) => [
    `${t.name} v${t.version} (${t.source})${t.name === doc.default ? " default" : ""}`,
    ...t.sections.map(
      (s) =>
        `  ${s.id}: ${s.heading} (${s.required ? "required" : "optional"})${s.guidance === null ? "" : ` — ${s.guidance}`}`,
    ),
  ]);
  return { headers: [], text: lines.length === 0 ? "No templates." : lines.join("\n") };
}

/** `adr_for_path`: per path, each decision's header and how it matched. */
export function forText(doc: DecisionsForJson, read: DecisionsRead): Text {
  const lines: string[] = [];
  for (const p of doc.paths) {
    lines.push(p.tracked ? p.path : `${p.path} (not tracked)`);
    if (p.decisions.length === 0 && p.unresolved.length === 0) lines.push("  no decisions");
    for (const d of p.decisions) {
      const view = read.projection.views.get(d.id);
      const h =
        view === undefined
          ? { line: `${named(read, d.id)} · ${d.status}`, warning: d.warning }
          : mcpHeader(view, read);
      lines.push(`  ${h.line}`);
      if (h.warning !== null) lines.push(`    ${h.warning}`);
      for (const via of d.via) {
        lines.push(
          via.type === "glob" ? `    via glob ${via.glob}` : `    via anchor line ${via.line}`,
        );
      }
    }
    for (const u of p.unresolved) {
      const why = u.reason === "other-log" ? "in another log" : "not in this log";
      lines.push(`  unresolved: ${u.ref} (line ${u.line}, ${why})`);
    }
  }
  return { headers: [], text: lines.join("\n") };
}

const SECTION_FINDING =
  /^(?:required )?section (.+?) (is missing|is empty|still contains its guidance text)$/;
const REASONS: Readonly<Record<string, string>> = {
  "is missing": "missing",
  "is empty": "empty",
  "still contains its guidance text": "guidance",
};

/** Lint findings as `Fill in: <heading> (<reason>)`, others as `Draft: <message> [<rule>]`. */
function lintLines(findings: readonly Finding[]): string[] {
  return findings.map((f) => {
    const m = SECTION_FINDING.exec(f.message);
    if (m === null) return `Draft: ${f.message} [${f.rule}]`;
    const [, heading = "", what = ""] = m;
    return `Fill in: ${heading} (${REASONS[what] ?? what})`;
  });
}

const noteLines = (doc: WriteResultJson) => doc.notes.map((n) => `Note: ${n}`);

/** What a write's text needs besides the document. */
export interface WriteTextOptions {
  /** The log read after the write, for the headers and how decisions display. */
  readonly read: DecisionsRead;
  /** For `adr_propose`: whether a human must accept. */
  readonly acceptRequiresHuman?: boolean;
  /** For `adr_scope`: the globs before the write. */
  readonly scopeBefore?: readonly string[];
  /** For `adr_update_draft`: the section ids sent. */
  readonly sections?: readonly string[];
  /** The tool, for the refusal's last line. */
  readonly tool: string;
}

/** A write's text: `Refused:` and the findings, or what was written; then the notes. */
export function writeText(doc: WriteResultJson, o: WriteTextOptions): Text {
  const { read } = o;
  const view =
    doc.decision === null ? null : (read.projection.views.get(doc.decision.id) ?? doc.decision);
  const headers = view === null ? [] : [mcpHeader(view, read)];
  if (!doc.ok) {
    const lint =
      doc.findings.length > 0 && doc.findings.every((f) => f.rule.startsWith("template/"));
    const again =
      lint && (o.tool === "adr_propose" || o.tool === "adr_update_draft")
        ? [`Fill in every required section and call ${o.tool} again.`]
        : [];
    const lines = [
      "Refused:",
      ...doc.findings.map(
        (f) => `  ${f.file === null ? "" : `${f.file}: `}${f.message} [${f.rule}]`,
      ),
      ...again,
      ...noteLines(doc),
    ];
    return { headers, text: lines.join("\n") };
  }
  if (view === null) return { headers, text: noteLines(doc).join("\n") };
  const lines = bodyLines(doc, view, o);
  return { headers, text: [...lines, ...noteLines(doc)].join("\n") };
}

function bodyLines(doc: WriteResultJson, v: DecisionView, o: WriteTextOptions): string[] {
  const { read } = o;
  const who = named(read, v.id);
  const recorded = doc.commit === null ? [] : [`Committed ${doc.commit.slice(0, 7)}.`];
  switch (doc.command) {
    case "new":
      return [
        `Proposed ${v.id}: ${v.title}`,
        ...(v.body_path === null ? [] : [`  ${v.body_path}`]),
        ...lintLines(doc.findings),
        ...recorded,
        o.acceptRequiresHuman === true
          ? `Next: ask a human to review and accept it (adr accept ${v.id})`
          : `Next: adr_accept or adr accept ${v.id}`,
      ];
    case "update":
      return doc.written.length === 0
        ? ["Unchanged"]
        : [
            `Updated the draft of ${who}: ${(o.sections ?? []).join(", ")}`,
            ...lintLines(doc.findings),
            ...recorded,
          ];
    case "note":
      return [`Noted on ${who}`, ...recorded];
    case "link": {
      const link = doc.written.length === 0 ? undefined : v.links.at(-1);
      if (link === undefined) return [`Links of ${who} unchanged`];
      return [`Linked ${who} ${link.rel} ${named(read, link.to)}`, ...recorded];
    }
    case "scope": {
      const before = new Set(o.scopeBefore ?? []);
      const after = new Set(v.applies_to);
      if (doc.written.length === 0) return ["unchanged"];
      return [
        ...v.applies_to.filter((g) => !before.has(g)).map((g) => `+ ${g}`),
        ...[...before].filter((g) => !after.has(g)).map((g) => `- ${g}`),
        `= ${v.applies_to.length === 0 ? "no globs" : v.applies_to.join(", ")}`,
        ...recorded,
      ];
    }
    case "accept":
      return [
        `Accepted ${who}: ${v.title}`,
        ...doc.affected.map((a) => `Superseded ${named(read, a.id)}: ${a.title}`),
        ...recorded,
      ];
    case "reject":
      return [`Rejected ${who}`, ...recorded];
    case "withdraw":
      return [`Withdrawn ${who}`, ...recorded];
    case "deprecate":
      return [`Deprecated ${who}`, ...recorded];
    case "supersede":
      return [`Superseded ${who} by ${named(read, v.superseded_by ?? "")}`, ...recorded];
    default:
      return [`${doc.command} ${who}`, ...recorded];
  }
}

/** The headers of a supersede's decision and of each decision it affected. */
export function affectedHeaders(doc: WriteResultJson, read: DecisionsRead): StateHeader[] {
  return doc.affected
    .filter((a) => a.id !== doc.decision?.id)
    .map((a) => mcpHeader(read.projection.views.get(a.id) ?? a, read));
}
