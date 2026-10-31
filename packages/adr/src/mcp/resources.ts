import { resolveSubjectInput, UsageError } from "@nikovirtala/ledger";
import type { McpResource, McpResourceTemplate } from "@nikovirtala/ledger/mcp";
import { adrKind } from "../kind.js";
import { type DecisionsRead, readDecisions, resolveDecision } from "../log.js";
import { renderDecisionIndexText } from "../log-index.js";
import { showDecision } from "../views.js";
import { mcpHeader } from "./text.js";
import { type AdrMcpEnv, openLog } from "./tools.js";

const MAX_ID = 64;

/**
 * Where an MCP client reads a decision: `adr://decision/ADR-0012` when numbered, else
 * `adr://decision/<id>`. The `refer` of every header the MCP texts show.
 */
export function decisionUri(read: DecisionsRead): (id: string) => string {
  return (id) => `adr://decision/${read.projection.views.get(id)?.display ?? id}`;
}

/** `adr://index`: the index table, numbered like every other read (design §7.7). */
export function indexResource(e: AdrMcpEnv): McpResource {
  return {
    uri: "adr://index",
    name: "index",
    title: "Decision index",
    description: "All decisions, grouped by status, with numbers and dates",
    mimeType: "text/markdown",
    async read() {
      return { header: null, text: renderDecisionIndexText(await readDecisions(await openLog(e))) };
    },
  };
}

/**
 * `adr://decision/{id}`: the decision's state header, then its body. `{id}` is the id, the number
 * (`12`, `0012`) or `ADR-0012`; an unknown one is not found, a malformed or qualified one is the
 * caller's error.
 */
export function decisionResource(e: AdrMcpEnv): McpResourceTemplate {
  return {
    uriTemplate: "adr://decision/{id}",
    name: "decision",
    title: "Decision",
    description:
      "One decision: its state header, then its body. {id} is the id (k3f9q8a1), the number (12) or ADR-0012",
    mimeType: "text/markdown",
    async read({ id = "" }) {
      if (id.length > MAX_ID) {
        throw new UsageError(
          `invalid decision ${JSON.stringify(`${id.slice(0, MAX_ID)}…`)}: an id or number is at most ${MAX_ID} characters`,
        );
      }
      const read = await readDecisions(await openLog(e));
      const r = resolveSubjectInput(id, {
        subjects: new Set(read.folded.subjects.keys()),
        kind: adrKind,
        numbering: read.numbering,
      });
      if (!r.ok && r.reason === "not-found") return null;
      const doc = await showDecision(read, resolveDecision(read, id));
      return {
        header: mcpHeader(doc.decision, read),
        text: doc.body === null ? "(no body file)\n" : doc.body,
      };
    },
  };
}
