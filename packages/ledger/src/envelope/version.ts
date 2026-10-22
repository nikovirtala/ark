/**
 * Version tag of the shared event envelope that every ledger-based kind writes.
 */
export const ENVELOPE_VERSION = "ledger/v1" as const;

export type EnvelopeVersion = typeof ENVELOPE_VERSION;
