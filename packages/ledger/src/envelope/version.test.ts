import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ENVELOPE_VERSION as ROOT_ENVELOPE_VERSION } from "../index.js";
import { ENVELOPE_VERSION } from "./version.js";

describe("ENVELOPE_VERSION", () => {
  it("is ledger/v1", () => {
    expect(ENVELOPE_VERSION).toBe("ledger/v1");
  });

  it("is re-exported unchanged from the root entry", () => {
    expect(ROOT_ENVELOPE_VERSION).toBe(ENVELOPE_VERSION);
  });

  it("equals only the string ledger/v1", () => {
    fc.assert(fc.property(fc.string(), (s) => (s === ENVELOPE_VERSION) === (s === "ledger/v1")));
  });

  it("has the form ledger/v<n>", () => {
    expect(ENVELOPE_VERSION).toMatch(/^ledger\/v\d+$/);
    fc.assert(fc.property(fc.nat(), (n) => /^ledger\/v\d+$/.test(`ledger/v${n}`)));
  });
});
