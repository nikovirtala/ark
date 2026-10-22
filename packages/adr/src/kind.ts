import { ENVELOPE_VERSION } from "@nikovirtala/ledger";

/**
 * The decision kind, as imported by other tools through `@nikovirtala/adr/kind`.
 *
 * Placeholder: replaced by a ledger `defineKind` definition in roadmap step 3. This module must
 * never import CLI or MCP code, so importing the kind stays cheap.
 */
export const adrKind = { name: "decision", envelope: ENVELOPE_VERSION } as const;
