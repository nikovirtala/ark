import { type Finding, formatText, renderStateHeader } from "@nikovirtala/ledger";
import type { IssuesInitJson } from "../init.js";
import type { IssueView } from "../kind.js";
import type { IssuesForJson } from "../scope.js";
import type { IssueSearchJson } from "../search.js";
import type { IssueListJson, IssueReadyJson, IssueShowJson } from "../views.js";
import type { IssueWorkJson } from "../work.js";
import type { IssueWriteJson } from "../write.js";

const short = (sha: string) => sha.slice(0, 7);
const day = (at: string | null) => (at ?? "").slice(0, 10);

/** One issue on one line: display, state, title and labels. */
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

const lines = (views: readonly IssueView[], none: string) =>
  views.length === 0 ? `${none}\n` : `${views.map(issueLine).join("\n")}\n`;

export const listText = (doc: IssueListJson): string => lines(doc.issues, "no issues");

/**
 * `issues list --since <rev>`: a header and each issue's line with what the pull brought it
 * (`[new: closed]`); nothing when it brought nothing, so the post-merge hook stays quiet.
 */
export function sinceText(doc: IssueListJson): string {
  const since = doc.since;
  if (since === null || doc.issues.length === 0) return "";
  return `${[
    `Changed since ${since.rev} (${short(since.commit)}):`,
    ...doc.issues.map((v) => {
      const types = [...new Set(since.events.filter((e) => e.subject === v.id).map((e) => e.type))];
      return `${issueLine(v)}  [new: ${types.join(", ")}]`;
    }),
  ].join("\n")}\n`;
}

export const readyText = (doc: IssueReadyJson): string => lines(doc.issues, "no ready issues");

/** A table: each column padded to its widest value, the last column not padded. */
function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
  );
}

/**
 * `issues search`: each result's `<display> (<id>)`, state and title, its state warning if any,
 * then its excerpt or which of id and title matched; then the count.
 */
export function searchText(doc: IssueSearchJson): string {
  const quoted = JSON.stringify(doc.query);
  if (doc.results.length === 0) {
    return `No ${doc.include_closed ? "" : "open "}issues match ${quoted}.\n`;
  }
  const rows = columns(
    doc.results.map(({ issue: v }) => [
      v.number === null ? v.id : `${v.display} (${v.id})`,
      v.state === "closed" && v.resolution !== null && v.resolution !== "done"
        ? `closed (${v.resolution})`
        : v.state,
      v.title,
    ]),
  );
  const out: string[] = [];
  doc.results.forEach((r, i) => {
    out.push(rows[i] ?? "");
    if (r.header.warning !== null) out.push(`  ${r.header.warning}`);
    const where = matchedFields(r.matched);
    out.push(r.excerpt === null ? `  (${where} match)` : `  ${r.excerpt}`);
  });
  const n = doc.total;
  out.push(`${n === 1 ? "1 issue matches" : `${n} issues match`} ${quoted}.`);
  return `${out.join("\n")}\n`;
}

/** Error and warning findings as `rule: message` lines, for stderr notes. */
export const findingNotes = (fs: readonly Finding[]): string[] =>
  fs.map((f) => `${f.rule}: ${f.message}`);

/** What a write did, or why it was refused. */
export function writeText(doc: IssueWriteJson, verb: string): string {
  const v = doc.issue;
  const subject = v === null ? "" : ` ${v.display}: ${v.title}`;
  if (!doc.ok) {
    const findings = formatText([...doc.findings]).trimEnd();
    return `not ${verb}${subject}\n${findings === "" ? "" : `${findings}\n`}`;
  }
  const out: string[] = [];
  if (doc.written.length === 0) out.push(`nothing written for${subject}`);
  else out.push(`${verb}${subject}`);
  if (v !== null && doc.written.length > 0) {
    out.push(`  ${v.display === v.id ? v.id : `${v.display} (${v.id})`} · ${v.state}`);
  }
  if (doc.commit !== null) out.push(`  committed ${short(doc.commit)}`);
  else if (doc.written.length > 0)
    out.push(`  staged ${doc.written.length} file${doc.written.length === 1 ? "" : "s"}`);
  return `${out.join("\n")}\n`;
}

/** `issues show`: the state header, the body, relations, comments, history and commits. */
export function showText(doc: IssueShowJson): string {
  const v = doc.issue;
  const out: string[] = [renderStateHeader(doc.header).trimEnd()];
  const facts = [
    `opened ${day(v.opened_at)}`,
    ...(v.assignees.length === 0 ? [] : [`assigned to ${v.assignees.join(", ")}`]),
    ...(v.labels.length === 0 ? [] : [`labels ${v.labels.join(", ")}`]),
    ...(v.applies_to.length === 0 ? [] : [`scope ${v.applies_to.join(", ")}`]),
  ];
  out.push(facts.join(" · "), "");
  if (doc.body !== null) out.push(doc.body.trimEnd(), "");
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
      const behalf =
        e.actor.kind === "agent" && e.actor.on_behalf_of !== null
          ? ` on behalf of ${e.actor.on_behalf_of}`
          : "";
      out.push(`  ${e.at} ${e.type} by ${e.actor.name}${behalf}${reason}`);
    }
    out.push("");
  }
  if (doc.commits !== null) {
    out.push("Commits:");
    if (doc.commits.length === 0) out.push("  none");
    for (const c of doc.commits) {
      const events = c.events.length === 0 ? "" : ` (${c.events.join(", ")})`;
      out.push(`  ${short(c.sha)} ${c.subject}${events}`);
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** `issues for`: each path with the issues that concern it. */
export function forText(doc: IssuesForJson, keyword: string): string {
  const out: string[] = [];
  for (const p of doc.paths) {
    out.push(`${p.path}${p.tracked ? "" : " (untracked)"}`);
    if (p.issues.length === 0 && p.unresolved.length === 0) out.push("  no issues");
    for (const i of p.issues) {
      const via = i.via.map((x) => (x.type === "glob" ? x.glob : `line ${x.line}`)).join(", ");
      out.push(`  ${i.display.padEnd(10)} ${i.state.padEnd(12)} ${i.title} (${via})`);
      if (i.warning !== null) out.push(`    ${i.warning}`);
    }
    for (const u of p.unresolved) {
      const why = u.reason === "other-log" ? "in another log" : "not in this log";
      out.push(`  ${keyword}:${u.ref} on line ${u.line} is ${why}`);
    }
  }
  return `${out.join("\n")}\n`;
}

export function workText(doc: IssueWorkJson): string {
  if (!doc.ok) return `${formatText([...doc.findings]).trimEnd()}\n`;
  return doc.current === null ? "no current issue\n" : `${issueLine(doc.current)}\n`;
}

export function initText(doc: IssuesInitJson): string {
  const out = [
    ...doc.written.map((p) => `wrote ${p}`),
    ...doc.kept.map((p) => `kept ${p}`),
    ...doc.removed.map((p) => `removed ${p}`),
    ...(doc.commit === null ? [] : [`committed ${short(doc.commit)}`]),
    ...(doc.skill !== null && doc.written.includes(doc.skill)
      ? ["Next: issues mcp, from your MCP client's config"]
      : []),
  ];
  return `${out.length === 0 ? "nothing to do" : out.join("\n")}\n`;
}

const FIELD_NAMES = { id: "id", title: "title", body: "description", comments: "comment" } as const;

/** The fields a result without an excerpt matched in, as in `title and description`. */
function matchedFields(matched: readonly (keyof typeof FIELD_NAMES)[]): string {
  return matched.map((f) => FIELD_NAMES[f]).join(" and ");
}
