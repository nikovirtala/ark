import { type JsonValue, resolveAttribution, UsageError } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { ISSUE_STATES, type IssueStatus } from "../kind.js";
import { readIssues } from "../log.js";
import { listIssues, myAddress } from "../views.js";
import { limitOf, openForCli, strings } from "./open.js";
import { listText } from "./text.js";

/** `issues list`: open and in-progress issues by default. */
export const listCommand: CommandSpec = {
  name: "list",
  summary: "list issues with their computed state (open and in progress by default)",
  usage:
    "list [--state open|in-progress|closed]… [--all] [--assignee <who|me>]… [--label <label>]… [--limit <n>]",
  options: {
    state: { type: "string", multiple: true },
    all: { type: "boolean" },
    assignee: { type: "string", multiple: true },
    label: { type: "string", multiple: true },
    limit: { type: "string" },
  },
  positionals: { min: 0, max: 0, names: [] },
  ref: "read",
  async run({ io, flags, values }) {
    const states = strings(values.state);
    for (const s of states) {
      if (!(ISSUE_STATES as readonly string[]).includes(s)) {
        throw new UsageError(`unknown --state ${s}; use ${ISSUE_STATES.join(", ")}`);
      }
    }
    const limit = limitOf(values.limit);
    const log = await openForCli(io, flags);
    let assignees = strings(values.assignee);
    if (assignees.includes("me")) {
      const { actor } = await resolveAttribution(log.git, { env: io.env });
      const me = myAddress(actor, "--assignee me");
      assignees = assignees.map((a) => (a === "me" ? me : a));
    }
    const doc = listIssues(await readIssues(log), {
      states: states as IssueStatus[],
      all: values.all === true,
      assignees,
      labels: strings(values.label),
      limit,
    });
    return { exit: 0, json: doc as unknown as JsonValue, text: listText(doc), notes: doc.notes };
  },
};
