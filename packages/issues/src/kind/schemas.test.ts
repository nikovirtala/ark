import { describe, expect, it } from "vitest";
import { ISSUE_REF } from "./schemas.js";

describe("ISSUE_REF", () => {
  it("is a local id or a source-qualified one", () => {
    expect(ISSUE_REF).toBe("^(?:[a-z][a-z0-9-]{0,31}:)?[0-9a-hjkmnp-tv-z]{8}$");
  });
});
