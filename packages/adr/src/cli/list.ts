import { type JsonValue, UsageError } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { DECISION_STATUSES, type DecisionStatus } from "../kind.js";
import { readDecisions, unavailableReason } from "../log.js";
import { listDecisions } from "../views.js";
import { openForCli } from "./open.js";
import { listText } from "./text.js";

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

/** `adr list [--status <status>]…` (design §5.6). */
export const listCommand: CommandSpec = {
  name: "list",
  summary: "list decisions with their computed status",
  usage: "list [--status <status>]…",
  options: { status: { type: "string", multiple: true } },
  positionals: { min: 0, max: 0, names: [] },
  ref: "read",
  async run({ io, flags, values }) {
    const status = statuses(values);
    const read = await readDecisions(await openForCli(io, flags));
    const doc = listDecisions(read, { status });
    const notes = [...doc.notes];
    if (!read.numbering.available && doc.decisions.length > 0) {
      notes.push(
        `numbers are unavailable (${unavailableReason(read.numbering)}); decisions display by id`,
      );
    }
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
    return { exit: 0, json: doc as unknown as JsonValue, text: listText(doc, display), notes };
  },
};
