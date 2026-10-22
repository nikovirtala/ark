import { ENVELOPE_VERSION } from "@nikovirtala/ledger";
import { expect, it } from "vitest";
import { adrKind } from "./kind.js";

it("defines the decision kind on the ledger envelope", () => {
  expect(adrKind.name).toBe("decision");
  expect(adrKind.envelope).toBe(ENVELOPE_VERSION);
});
