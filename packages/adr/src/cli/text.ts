import { type EventEnvelope, renderStateHeader } from "@nikovirtala/ledger";
import type { DecisionView } from "../kind.js";
import type { DecisionListJson, DecisionShowJson } from "../views.js";

/** How a decision id is shown: its display (`ADR-0007`), or the id when it has no number. */
export type Display = (id: string) => string;

/** A table: each column padded to its widest value, trailing spaces removed. */
function columns(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** `adr list`: one row per decision, `→ <effective>` when it differs from the decision. */
export function listText(doc: DecisionListJson, display: Display): string {
  if (doc.decisions.length === 0) return "No decisions.";
  return columns(
    doc.decisions.map((v) => {
      const arrow =
        v.effective === null
          ? "→ (cycle)"
          : v.effective === v.id
            ? ""
            : `→ ${display(v.effective)}`;
      return [v.number === null ? "-" : v.display, v.id, v.status, v.title, arrow];
    }),
  );
}

/** `ADR-0003 (m2x7p4d2)`, or the id alone when it has no number. */
function named(id: string, display: Display): string {
  const shown = display(id);
  return shown === id ? id : `${shown} (${id})`;
}

const day = (at: string | null) => (at ?? "").slice(0, 10);
const list = (ids: readonly string[], display: Display) =>
  ids.length === 0 ? "none" : ids.map((id) => named(id, display)).join(", ");

function bodyLine(v: DecisionView): string {
  if (v.body_path === null) return "missing";
  if (v.body_intact === null) return v.body_path;
  return `${v.body_path} (${v.body_intact ? "intact" : "changed after acceptance"})`;
}

function actorText(e: EventEnvelope): string {
  const a = e.actor;
  return a.kind === "agent" ? `${a.name} (agent ${a.agent} for ${a.on_behalf_of})` : a.name;
}

/** The second line of an event in `show --history`: its reason, else a summary of its data. */
function eventDetail(e: EventEnvelope): string | null {
  if (typeof e.reason === "string") return `reason: ${e.reason}`;
  const entries = Object.entries(e.data);
  if (entries.length === 0) return null;
  return entries
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

function historyLines(events: readonly EventEnvelope[]): string[] {
  const width = Math.max(...events.map((e) => e.type.length));
  return events.flatMap((e) => {
    const detail = eventDetail(e);
    return [
      `  ${e.at}  ${e.type.padEnd(width)}  ${actorText(e)}`,
      ...(detail === null ? [] : [`    ${detail}`]),
    ];
  });
}

/** `adr show`: the state header, the decision's fields and its body. */
export function showText(doc: DecisionShowJson, display: Display): string {
  const v = doc.decision;
  const supersedes =
    v.supersedes.length === 0 && v.declared_supersedes.length > 0
      ? `none (declared: ${list(v.declared_supersedes, display)})`
      : list(v.supersedes, display);
  const fields: [string, string][] = [
    ["Title", v.title],
    ["Status", `${v.status} (${day(v.status_at)})`],
    ["Effective", v.effective === null ? "none (supersession cycle)" : named(v.effective, display)],
    ["Chain", v.chain.map(display).join(" → ")],
    ["Supersedes", supersedes],
    ["Applies to", v.applies_to.length === 0 ? "none" : v.applies_to.join(", ")],
    ["Body", bodyLine(v)],
  ];
  if (doc.events === null) fields.push(["History", v.history.join(" · ")]);
  const width = Math.max(...fields.map(([k]) => k.length)) + 2;
  const lines = fields.map(([k, value]) => `${`${k}:`.padEnd(width)}${value}`);
  if (doc.events !== null) lines.push("History:", ...historyLines(doc.events));
  const body = doc.body === null ? "" : `\n${doc.body.endsWith("\n") ? doc.body : `${doc.body}\n`}`;
  return `${renderStateHeader(doc.header)}\n${lines.join("\n")}\n${body}`;
}
