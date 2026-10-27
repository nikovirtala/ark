import { type JsonValue, UsageError } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { DECISION_STATUSES, type DecisionStatus } from "../kind.js";
import { changedSince, numberingNote, readDecisions } from "../log.js";
import { readSourceDecisions } from "../sources.js";
import { listDecisions } from "../views.js";
import { openForCli } from "./open.js";
import { listText, sinceText } from "./text.js";

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

function statuses(values: Readonly<Record<string, unknown>>): DecisionStatus[] {
  const given = Array.isArray(values.status) ? (values.status as string[]) : [];
  return given.map((s) => {
    if (!(DECISION_STATUSES as readonly string[]).includes(s)) {
      throw new UsageError(
        `unknown status ${JSON.stringify(s)}; use one of ${DECISION_STATUSES.join(", ")}`,
      );
    }
    return s as DecisionStatus;
  });
}

/** `--since`'s revision: non-empty and not an option. */
function sinceRev(values: Readonly<Record<string, unknown>>): string | null {
  const v = values.since;
  if (typeof v !== "string") return null;
  if (v.trim() === "" || v.startsWith("-")) throw new UsageError("--since must be a revision");
  return v;
}

/**
 * `adr list [--status <status>]… [--since <rev>] [--source <name>]` (design §5.6, 2b D7):
 * `--source` lists a `[[sources]]` entry's cached log instead of the local one.
 */
export const listCommand: CommandSpec = {
  name: "list",
  summary: "list decisions with their computed status",
  usage: "list [--status <status>]… [--since <rev>] [--source <name>]",
  options: {
    status: { type: "string", multiple: true },
    since: { type: "string" },
    source: { type: "string" },
  },
  positionals: { min: 0, max: 0, names: [] },
  ref: "read",
  async run({ io, flags, values }) {
    const status = statuses(values);
    const rev = sinceRev(values);
    const source = typeof values.source === "string" ? values.source : null;
    if (source !== null && rev !== null) {
      throw new UsageError("--source can't be combined with --since");
    }
    const log = await openForCli(io, flags);
    const since = rev === null ? null : await changedSince(log, rev);
    const read =
      source === null ? await readDecisions(log) : await readSourceDecisions(log, source);
    const doc = listDecisions(read, { status, since });
    const notes = [...doc.notes];
    const numbering = numberingNote(read, { unavailable: true });
    if (numbering !== null && doc.decisions.length > 0) notes.push(numbering);
    if (doc.findings.length > 0) {
      notes.push(
        `the decision log has ${plural(doc.findings.length, "problem", "problems")}; run adr verify`,
      );
    }
    if (doc.unreadable.length > 0) {
      notes.push(
        `${plural(doc.unreadable.length, "decision uses", "decisions use")} a newer format; upgrade adr`,
      );
    }
    if (doc.unfoldable.length > 0) {
      notes.push(
        `${plural(doc.unfoldable.length, "decision", "decisions")} can't be read; run adr verify`,
      );
    }
    const display = (id: string) => read.projection.views.get(id)?.display ?? id;
    const text = doc.since === null ? listText(doc, display) : sinceText(doc, doc.since, display);
    return { exit: 0, json: doc as unknown as JsonValue, text, notes };
  },
};
