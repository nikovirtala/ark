import type { Actor, Finding } from "@nikovirtala/ledger";
import type { AdrConfig } from "../config.js";
import { adrKind, type DecisionView } from "../kind.js";
import type { DecisionsRead } from "../log.js";

/** The tools that decide; listed only with `[policy] mcp_can_decide = true`. */
export const DECISION_TOOLS = [
  "adr_accept",
  "adr_reject",
  "adr_deprecate",
  "adr_supersede",
] as const;

/** Whether `adr mcp` offers the decision tools (design §7.5, Table A). */
export function decisionToolsAvailable(adr: AdrConfig): boolean {
  return adr.mcpCanDecide;
}

/**
 * Who a proposal is for (design D5): its `proposed` event's actor, `on_behalf_of` for an agent
 * and `email` for a human, lower-cased; `null` when the event or the address is missing.
 */
export function proposalOwner(read: DecisionsRead, id: string): string | null {
  const proposed = read.folded.subjects
    .get(id)
    ?.applied.find((a) => a.event.type === adrKind.machine.initial.type);
  const actor = proposed?.event.actor;
  if (actor === undefined) return null;
  const owner = actor.kind === "agent" ? actor.on_behalf_of : actor.email;
  return typeof owner === "string" && owner.trim() !== "" ? owner.trim().toLowerCase() : null;
}

/** The writes `mcpWriteRefusal` judges: the ones whose ownership matters. */
export type PolicyTool = "adr_scope" | "adr_update_draft" | "adr_withdraw";

/**
 * The MCP policy (design §7.5, Table B): `null` when the write may go ahead, else the
 * `decision/mcp-cannot-decide` finding. Without `mcp_can_decide` an agent may scope, edit and
 * withdraw only the proposals made for the person it acts for, and rescope no accepted or
 * deprecated decision.
 * Writes the state machine forbids anyway get `null`, so the library refuses them with the real
 * reason.
 */
export function mcpWriteRefusal(o: {
  readonly tool: PolicyTool;
  readonly view: DecisionView;
  readonly owner: string | null;
  readonly actor: Actor;
  readonly mcpCanDecide: boolean;
  readonly display: (id: string) => string;
  /** The finding's file when the decision has no body: its events directory. */
  readonly eventsDir: string;
}): Finding | null {
  const { view } = o;
  if (o.tool === "adr_scope" && !adrKind.machine.allowed(view.status, "scoped")) return null;
  if (o.tool === "adr_update_draft" && view.status !== "proposed") return null;
  if (o.tool === "adr_withdraw" && !adrKind.machine.allowed(view.status, "withdrawn")) return null;
  if (o.mcpCanDecide) return null;
  const me = o.actor.on_behalf_of?.trim().toLowerCase() ?? null;
  if (view.status === "proposed" && o.owner !== null && o.owner === me) return null;
  const shown = o.display(view.id);
  const named = shown === view.id ? view.id : `${shown} (${view.id})`;
  const verb = o.tool === "adr_withdraw" ? "withdrawing" : "changing";
  const message =
    view.status === "proposed"
      ? `${named} was proposed for ${o.owner ?? "someone else"}, and you act for ${o.actor.on_behalf_of ?? "nobody"}; ${verb} another person's proposal needs [policy] mcp_can_decide = true. Add a note with adr_note instead.`
      : `${named} is ${view.status}; rescoping it needs [policy] mcp_can_decide = true, because narrowing a scope can switch a decision off. Ask a human to run adr scope ${shown} …, or propose a superseding decision.`;
  return {
    severity: "error",
    rule: "decision/mcp-cannot-decide",
    message,
    file: view.body_path ?? o.eventsDir,
    line: null,
    subject: view.id,
    kind: adrKind.name,
  };
}
