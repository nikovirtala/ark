import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { envelopeSchema } from "./schema.js";
import { ENVELOPE_KEYS } from "./types.js";

describe("envelopeSchema", () => {
  it("is a draft 2020-12 schema with the ledger/v1 id", () => {
    expect(envelopeSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(envelopeSchema.$id).toBe("urn:nikovirtala:ledger:envelope:v1");
  });

  it("requires every known key but reason, and stays open", () => {
    expect(envelopeSchema.required).toEqual(ENVELOPE_KEYS.filter((k) => k !== "reason"));
    expect(envelopeSchema).not.toHaveProperty("additionalProperties");
    expect(envelopeSchema).not.toHaveProperty("unevaluatedProperties");
  });

  it("compiles under ajv strict mode", () => {
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, logger: false });
    expect(() => ajv.compile(envelopeSchema)).not.toThrow();
  });
});
