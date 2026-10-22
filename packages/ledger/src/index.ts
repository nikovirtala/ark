/**
 * Version tag of the shared event envelope that every ledger-based kind writes.
 *
 * The envelope itself, and the rest of ledger's mechanical core, arrive in roadmap step 2
 * (docs/00-ark-v1.md).
 */
export const ENVELOPE_VERSION = "ledger/v1" as const;

export type EnvelopeVersion = typeof ENVELOPE_VERSION;
