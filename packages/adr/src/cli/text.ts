import { type EventEnvelope, type Finding, renderStateHeader } from "@nikovirtala/ledger";
import type { DecisionView } from "../kind.js";
import type { DecisionListJson, DecisionShowJson } from "../views.js";
import type { WriteResultJson } from "../write.js";

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

const SECTION_FINDING =
  /^(?:required )?section (.+?) (is missing|is empty|still contains its guidance text)$/;
const REASONS: Readonly<Record<string, string>> = {
  "is missing": "missing",
  "is empty": "empty",
  "still contains its guidance text": "guidance text left",
};

/**
 * The draft lint of `new` as advice: `Fill in N sections before accepting: A, B (why)` for the
 * section findings, and one line per other finding.
 */
function draftAdvice(findings: readonly Finding[]): string[] {
  const headings: string[] = [];
  const reasons: string[] = [];
  const other: string[] = [];
  for (const f of findings) {
    const m = SECTION_FINDING.exec(f.message);
    if (m === null) {
      other.push(`Draft: ${f.message} [${f.rule}]`);
      continue;
    }
    const [, heading = "", what = ""] = m;
    const reason = REASONS[what] ?? what;
    if (!headings.includes(heading)) headings.push(heading);
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  const n = headings.length;
  return [
    ...(n === 0
      ? []
      : [
          `Fill in ${n === 1 ? "1 section" : `${n} sections`} before accepting: ${headings.join(", ")} (${reasons.join(", ")})`,
        ]),
    ...other,
  ];
}

function findingLines(findings: readonly Finding[]): string[] {
  return findings.map((f) => `  ${f.file === null ? "" : `${f.file}: `}${f.message} [${f.rule}]`);
}

const short = (sha: string) => sha.slice(0, 7);

export interface FollowRenamesBefore {
  readonly before: ReadonlyMap<string, readonly string[]>;
  readonly renamed: boolean;
}

/**
 * `adr scope --follow-renames`: one `<named>: <old globs> → <new globs>` line per changed
 * decision (`affected`), whether or not a decision was given.
 */
function followRenamesText(doc: WriteResultJson, display: Display, o: FollowRenamesBefore): string {
  if (!o.renamed) return "No staged renames.";
  if (doc.affected.length === 0) return "No scope globs follow the staged renames.";
  const lines = doc.affected.map((v) => {
    const before = o.before.get(v.id) ?? [];
    const old = before.filter((g) => !v.applies_to.includes(g));
    const now = v.applies_to.filter((g) => !before.includes(g));
    const change =
      old.length === 0 ? `+ ${now.join(", ")}` : `${old.join(", ")} → ${now.join(", ")}`;
    return `${named(v.id, display)}: ${change}`;
  });
  return [...lines, "Staged; commit the scoped events with the renames."].join("\n");
}

/** The past participle of each write command, for `Not <verb>: …`. */
const VERBS: Readonly<Record<WriteResultJson["command"], string>> = {
  new: "proposed",
  accept: "accepted",
  supersede: "superseded",
  reject: "rejected",
  withdraw: "withdrawn",
  deprecate: "deprecated",
  note: "noted",
  link: "linked",
  scope: "scoped",
};

/**
 * The text of a write command (design §5.6, §6.1). `subject` names what a refused command was
 * about; `number` is the decision's number in the write result, if it has one now; `reason` is
 * the reason a lifecycle exit recorded.
 */
export function writeText(
  doc: WriteResultJson,
  display: Display,
  o: {
    readonly subject: string;
    readonly number: string | null;
    readonly reason?: string | null;
    /** The decision's globs before a `scope` write. */
    readonly scopeBefore?: readonly string[];
    /** For `scope --follow-renames`: every decision's globs before, and whether renames were staged. */
    readonly followRenames?: FollowRenamesBefore;
  },
): string {
  const verb = VERBS[doc.command];
  if (!doc.ok) return [`Not ${verb}: ${o.subject}`, ...findingLines(doc.findings)].join("\n");
  // Before the null-decision guard: without a <decision>, `decision` is null (design-review L1).
  if (o.followRenames !== undefined) return followRenamesText(doc, display, o.followRenames);
  const v = doc.decision;
  if (v === null) return "";
  const committed = doc.commit === null ? null : `Committed ${short(doc.commit)}`;
  const recorded = committed === null ? "Staged; commit to record it." : `${committed}.`;
  switch (doc.command) {
    case "new":
      return [
        `Proposed ${v.id}: ${v.title}`,
        ...doc.written.map((p) => `  ${p}`),
        ...draftAdvice(doc.findings),
        ...(committed === null ? [] : [`${committed}.`]),
        `Next: adr accept ${v.id}`,
      ].join("\n");
    case "accept":
      return [
        `Accepted ${v.id}: ${v.title}`,
        ...doc.affected.map((a) => `Superseded ${named(a.id, display)}: ${a.title}`),
        committed === null
          ? "Staged; commit to record it."
          : o.number === null
            ? `${committed}. The number is assigned when this commit lands on main.`
            : `${committed} as ${o.number}.`,
      ].join("\n");
    case "supersede":
      return [
        `Superseded ${named(v.id, display)}: ${v.title}`,
        `  by ${named(v.superseded_by ?? "", display)}`,
        recorded,
      ].join("\n");
    case "reject":
    case "withdraw":
    case "deprecate":
      return [
        `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${named(v.id, display)}: ${v.title}`,
        ...(o.reason === undefined || o.reason === null ? [] : [`  reason: ${o.reason}`]),
        recorded,
      ].join("\n");
    case "note":
      return [`Noted on ${named(v.id, display)}: ${v.title}`, recorded].join("\n");
    case "link": {
      // The reducer appends a new link, so the one written is the last.
      const link = doc.written.length === 0 ? undefined : v.links.at(-1);
      if (link === undefined) return `Links of ${named(v.id, display)} unchanged`;
      return [
        `Linked ${named(v.id, display)} ${link.rel} ${named(link.to, display)}`,
        recorded,
      ].join("\n");
    }
    case "scope": {
      const before = new Set(o.scopeBefore ?? []);
      const after = new Set(v.applies_to);
      const globs = v.applies_to.length === 0 ? "no globs" : v.applies_to.join(", ");
      if (doc.written.length === 0) return `Scope of ${named(v.id, display)} unchanged: ${globs}`;
      return [
        `Scope of ${named(v.id, display)}: ${v.title}`,
        ...v.applies_to.filter((g) => !before.has(g)).map((g) => `  + ${g}`),
        ...[...before].filter((g) => !after.has(g)).map((g) => `  - ${g}`),
        `  = ${globs}`,
        recorded,
      ].join("\n");
    }
  }
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
