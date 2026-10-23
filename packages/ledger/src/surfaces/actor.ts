import type { Actor } from "../envelope/types.js";
import { ConfigError } from "../errors.js";
import type { Git } from "../git/git.js";

const AGENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

/**
 * Who a tool writes events as (design D5): the configured git identity (never a guessed
 * `user@hostname`), as a human, or as an agent acting for that identity when `o.agent` or
 * `ARK_AGENT` names one. Throws `ConfigError` without an identity or for an invalid agent name.
 */
export async function resolveActor(
  git: Git,
  o: { readonly env?: NodeJS.ProcessEnv; readonly agent?: string | null } = {},
): Promise<Actor> {
  const given = o.agent ?? null;
  const agent = (given ?? (o.env ?? process.env).ARK_AGENT ?? "").trim();
  if (agent !== "" && !AGENT.test(agent)) {
    const what = given === null ? "ARK_AGENT" : "agent name";
    throw new ConfigError(`${what} ${JSON.stringify(agent)} must match ${AGENT.source}`);
  }
  const identity = await git.identity();
  if (identity === null) {
    throw new ConfigError("no git identity; set git user.name and user.email");
  }
  if (agent === "") {
    return {
      kind: "human",
      name: identity.name,
      email: identity.email,
      agent: null,
      on_behalf_of: null,
    };
  }
  return { kind: "agent", name: agent, email: null, agent, on_behalf_of: identity.email };
}
