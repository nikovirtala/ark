import type { JsonSchema } from "./types.js";
import { ENVELOPE_VERSION } from "./version.js";

const NAME = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
const nullableString = { type: ["string", "null"] } as const;

/**
 * JSON Schema (draft 2020-12) of the `ledger/v1` envelope. Objects stay open, so unknown fields
 * are allowed and preserved. `actor.kind: agent` requires a non-empty `actor.agent`.
 */
export const envelopeSchema: JsonSchema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:nikovirtala:ledger:envelope:v1",
  type: "object",
  required: ["envelope", "kind", "schema", "id", "subject", "type", "at", "actor", "data"],
  properties: {
    envelope: { const: ENVELOPE_VERSION },
    kind: { type: "string", pattern: NAME, maxLength: 64 },
    schema: {
      type: "string",
      pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*/v[1-9][0-9]*$",
      maxLength: 72,
    },
    id: { type: "string", pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
    subject: { type: "string", pattern: "^[0-9a-hjkmnp-tv-z]{8}$" },
    type: { type: "string", pattern: NAME, maxLength: 64 },
    at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$" },
    actor: {
      type: "object",
      required: ["kind", "name"],
      properties: {
        kind: { enum: ["human", "agent"] },
        name: { type: "string", minLength: 1 },
        email: nullableString,
        agent: nullableString,
        on_behalf_of: nullableString,
      },
      if: { properties: { kind: { const: "agent" } }, required: ["kind"] },
      // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword
      then: { required: ["agent"], properties: { agent: { type: "string", minLength: 1 } } },
    },
    reason: { type: ["string", "null"], minLength: 1 },
    data: { type: "object" },
  },
});
