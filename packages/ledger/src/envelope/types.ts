import type { EnvelopeVersion } from "./version.js";

/** Who wrote an event. Agent-written events name the agent. */
export interface Actor {
  readonly kind: "human" | "agent";
  readonly name: string;
  readonly email?: string | null;
  readonly agent?: string | null;
  readonly on_behalf_of?: string | null;
}

/**
 * The shared `ledger/v1` envelope. Unknown fields at any level are preserved as read, so the type
 * describes the known part only.
 */
export interface EventEnvelope<D extends object = Record<string, unknown>> {
  readonly envelope: EnvelopeVersion;
  readonly kind: string;
  /** `<kind>/v<n>`, the kind's data-schema version. */
  readonly schema: string;
  /** A ULID. */
  readonly id: string;
  readonly subject: string;
  readonly type: string;
  /** `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly at: string;
  readonly actor: Actor;
  readonly reason?: string | null;
  readonly data: D;
}

export type JsonSchema = Readonly<Record<string, unknown>>;

/** Known envelope keys in canonical (serialization) order. */
export const ENVELOPE_KEYS: readonly string[] = Object.freeze([
  "envelope",
  "kind",
  "schema",
  "id",
  "subject",
  "type",
  "at",
  "actor",
  "reason",
  "data",
]);

/** Known actor keys in canonical order. */
export const ACTOR_KEYS: readonly string[] = Object.freeze([
  "kind",
  "name",
  "email",
  "agent",
  "on_behalf_of",
]);

/** The own enumerable fields of `o` whose keys aren't in `known`, in insertion order. */
export function unknownFields(o: object, known: readonly string[]): Record<string, unknown> {
  const skip = new Set(known);
  return Object.fromEntries(Object.entries(o).filter(([k]) => !skip.has(k)));
}
