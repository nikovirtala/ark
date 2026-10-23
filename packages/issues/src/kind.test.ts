import { adrKind } from "@nikovirtala/adr/kind";
import { ENVELOPE_VERSION, isKind } from "@nikovirtala/ledger";
import { expect, it } from "vitest";
import { issueKind } from "./kind.js";

it("defines the issue kind on the ledger envelope", () => {
  expect(issueKind.name).toBe("issue");
  expect(issueKind.envelope).toBe(ENVELOPE_VERSION);
});

it("reads adr's kind through the @nikovirtala/adr/kind subpath", () => {
  expect(adrKind.name).toBe("decision");
  expect(adrKind.schema).toBe("decision/v1");
  expect(isKind(adrKind)).toBe(true); // isKind from @nikovirtala/ledger
});
