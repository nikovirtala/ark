import type { Actor } from "../envelope/types.js";
import { ConfigError } from "../errors.js";
import type { Git } from "../git/git.js";

const AGENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;
const MAX_EMAIL = 254;

/** Who a write is recorded as, and the notes the tool shows about how that was decided. */
export interface Attribution {
  readonly actor: Actor;
  readonly notes: readonly string[];
}

/**
 * `ARK_ON_BEHALF_OF`, trimmed: `null` when unset or blank, else an email address (one `@`, no
 * whitespace or address punctuation, at most 254 characters). Throws `ConfigError` otherwise.
 */
export function parseOnBehalfOf(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  if (v.length > MAX_EMAIL || !EMAIL.test(v)) {
    throw new ConfigError(
      `ARK_ON_BEHALF_OF ${JSON.stringify(v.slice(0, 100))} is not an email address`,
    );
  }
  return v;
}

/**
 * Who a tool writes events as (design §5): a human with the configured git identity (never a
 * guessed `user@hostname`), or an agent when `o.agent` or `ARK_AGENT` names one, acting for
 * `ARK_ON_BEHALF_OF` or, with a note, for the git identity's email. With both an agent and
 * `ARK_ON_BEHALF_OF`, the git identity isn't read. Both values are checked first, so an invalid
 * one is a `ConfigError` even when it wouldn't be used; so is a missing identity that is needed.
 */
export async function resolveAttribution(
  git: Git,
  o: { readonly env?: NodeJS.ProcessEnv; readonly agent?: string | null } = {},
): Promise<Attribution> {
  const env = o.env ?? process.env;
  const given = o.agent ?? null;
  const agent = (given ?? env.ARK_AGENT ?? "").trim();
  if (agent !== "" && !AGENT.test(agent)) {
    const what = given === null ? "ARK_AGENT" : "agent name";
    throw new ConfigError(`${what} ${JSON.stringify(agent)} must match ${AGENT.source}`);
  }
  const behalf = parseOnBehalfOf(env.ARK_ON_BEHALF_OF);
  if (agent !== "" && behalf !== null) {
    return {
      actor: { kind: "agent", name: agent, email: null, agent, on_behalf_of: behalf },
      notes: [],
    };
  }
  const identity = await git.identity();
  if (identity === null) {
    throw new ConfigError("no git identity; set git user.name and user.email");
  }
  if (agent === "") {
    const actor: Actor = {
      kind: "human",
      name: identity.name,
      email: identity.email,
      agent: null,
      on_behalf_of: null,
    };
    const notes =
      behalf === null
        ? []
        : [
            `ARK_ON_BEHALF_OF is ignored without ARK_AGENT; events are recorded as ${identity.name} <${identity.email}>`,
          ];
    return { actor, notes };
  }
  return {
    actor: { kind: "agent", name: agent, email: null, agent, on_behalf_of: identity.email },
    notes: [
      `on_behalf_of taken from the git identity ${identity.email}; set ARK_ON_BEHALF_OF to name who you act for`,
    ],
  };
}

/** `(await resolveAttribution(git, o)).actor`. */
export async function resolveActor(
  git: Git,
  o: { readonly env?: NodeJS.ProcessEnv; readonly agent?: string | null } = {},
): Promise<Actor> {
  return (await resolveAttribution(git, o)).actor;
}
