import { type JsonValue, resolveAttribution, UsageError } from "@nikovirtala/ledger";
import type { CommandSpec } from "@nikovirtala/ledger/cli";
import { ISSUE_STATES, type IssueStatus } from "../kind.js";
import { changedSince, readIssues, readSourceIssues, sourcesNote } from "../log.js";
import { listIssues, myAddress } from "../views.js";
import { limitOf, openForCli, strings } from "./open.js";
import { listText, sinceText } from "./text.js";

/** `--since`'s revision: non-empty and not an option (adr's rule). */
function sinceRev(values: Readonly<Record<string, unknown>>): string | null {
  const v = values.since;
  if (typeof v !== "string") return null;
  if (v.trim() === "" || v.startsWith("-")) throw new UsageError("--since must be a revision");
  return v;
}

/**
 * `issues list`: open and in-progress issues by default; `--source` lists a `[[sources]]` entry's
 * cached issue log instead of the local one; `--since <rev>` lists the issues closed, reopened or
 * assigned to you since `rev` (the post-merge hook's `--since ORIG_HEAD`).
 */
export const listCommand: CommandSpec = {
  name: "list",
  summary: "list issues with their computed state (open and in progress by default)",
  usage:
    "list [--state open|in-progress|closed]… [--all] [--assignee <who|me>]… [--label <label>]… [--limit <n>] [--source <name>] [--since <rev>]",
  options: {
    state: {
      type: "string",
      multiple: true,
      value: "<state>",
      help: "open, in-progress or closed (default: open and in-progress)",
    },
    all: { type: "boolean", help: "list issues in every state" },
    assignee: {
      type: "string",
      multiple: true,
      value: "<who|me>",
      help: "only issues assigned to <who>; me is you",
    },
    label: {
      type: "string",
      multiple: true,
      value: "<label>",
      help: "only issues with this label",
    },
    limit: { type: "string", value: "<n>", help: "list at most <n> issues (1 to 1000)" },
    source: {
      type: "string",
      value: "<name>",
      help: "list a cached [[sources]] log instead of this one",
    },
    since: {
      type: "string",
      value: "<rev>",
      help: "the issues closed, reopened or assigned to you since <rev>",
    },
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
    const rev = sinceRev(values);
    if (rev !== null && typeof values.source === "string") {
      throw new UsageError("--source can't be combined with --since");
    }
    const log = await openForCli(io, flags);
    let assignees = strings(values.assignee);
    if (assignees.includes("me")) {
      const { actor } = await resolveAttribution(log.git, { env: io.env });
      const me = myAddress(actor, "--assignee me");
      assignees = assignees.map((a) => (a === "me" ? me : a));
    }
    const since = rev === null ? null : await changedSince(log, rev);
    let me: string | null = null;
    if (since !== null) {
      const { actor } = await resolveAttribution(log.git, { env: io.env });
      me = (actor.kind === "agent" ? actor.on_behalf_of : actor.email) ?? null;
    }
    const read =
      typeof values.source === "string"
        ? await readSourceIssues(log, values.source)
        : await readIssues(log);
    const doc = listIssues(read, {
      states: states as IssueStatus[],
      all: values.all === true,
      assignees,
      labels: strings(values.label),
      limit,
      since,
      me,
    });
    const text = doc.since === null ? listText(doc) : sinceText(doc);
    // `--since` runs on every pull (post-merge), so it leaves out the sources note to stay quiet.
    const sources = sourcesNote(read);
    const notes = doc.since === null ? doc.notes : doc.notes.filter((n) => n !== sources);
    return { exit: 0, json: doc as unknown as JsonValue, text, notes };
  },
};
