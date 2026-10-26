import type { DecisionsRead } from "../log.js";

/**
 * Where an MCP client reads a decision: `adr://decision/ADR-0012` when numbered, else
 * `adr://decision/<id>`. The `refer` of every header the MCP texts show.
 */
export function decisionUri(read: DecisionsRead): (id: string) => string {
  return (id) => `adr://decision/${read.projection.views.get(id)?.display ?? id}`;
}
