import type { Git } from "../git/git.js";
import { type Attribution, resolveAttribution } from "../surfaces/actor.js";
import type { McpContext } from "./types.js";

const MAX_AGENT = 64;
const FALLBACK_AGENT = "mcp-client";

/**
 * A client name as an agent name ledger accepts (`^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$`): other
 * characters become `-`, leading ones up to the first letter or digit are dropped, runs of `-`
 * collapse, and it is cut to 64 characters. `null` when nothing usable is left.
 */
export function mcpAgentName(clientName: string | null | undefined): string | null {
  const safe = [...(clientName ?? "").trim()]
    .map((c) => (/^[A-Za-z0-9._ -]$/.test(c) ? c : "-"))
    .join("")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_AGENT)
    .trim();
  return safe === "" ? null : safe;
}

/**
 * Who an MCP write is recorded as: always an agent, named by the MCP client (01:277), else by
 * `ARK_AGENT`, else `mcp-client`, acting for `ARK_ON_BEHALF_OF` or, with a note, the git
 * identity. A note says when the client's name couldn't be used as it is. Throws `ConfigError`
 * as `resolveAttribution` does.
 */
export async function mcpAttribution(git: Git, ctx: McpContext): Promise<Attribution> {
  const raw = ctx.client?.name ?? null;
  const safe = mcpAgentName(raw);
  let agent: string;
  let note: string | null = null;
  if (safe !== null) {
    agent = safe;
    if (safe !== raw) {
      note = `MCP client name ${JSON.stringify(raw)} is recorded as agent ${JSON.stringify(safe)}`;
    }
  } else {
    const fromEnv = (ctx.env.ARK_AGENT ?? "").trim();
    agent = fromEnv === "" ? FALLBACK_AGENT : fromEnv;
    note = `the MCP client sent no usable name; recorded as agent ${agent}`;
  }
  const r = await resolveAttribution(git, { env: ctx.env, agent });
  return { actor: r.actor, notes: note === null ? r.notes : [note, ...r.notes] };
}
