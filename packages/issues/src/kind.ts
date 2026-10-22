import { ENVELOPE_VERSION } from "@nikovirtala/ledger";

/**
 * The issue kind, as imported by other tools through `@nikovirtala/issues/kind`.
 *
 * Placeholder: replaced by a ledger `defineKind` definition in roadmap step 4. This module must
 * never import CLI or MCP code, so importing the kind stays cheap.
 */
export const issueKind = { name: "issue", envelope: ENVELOPE_VERSION } as const;
