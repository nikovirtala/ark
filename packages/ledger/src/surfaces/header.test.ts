import { describe, expect, it } from "vitest";
import { renderStateHeader } from "./header.js";

describe("renderStateHeader", () => {
  it("prints the line alone for an active subject", () => {
    expect(renderStateHeader({ line: "ADR-0002 (k3f9q8a1) · accepted", warning: null })).toBe(
      "ADR-0002 (k3f9q8a1) · accepted\n",
    );
  });

  it("prints the warning on its own line after the state line", () => {
    expect(
      renderStateHeader({
        line: "ADR-0001 (a7c2m9xd) · superseded",
        warning: "SUPERSEDED by ADR-0002 (accepted 2026-03-14). Do not apply this decision.",
      }),
    ).toBe(
      "ADR-0001 (a7c2m9xd) · superseded\nSUPERSEDED by ADR-0002 (accepted 2026-03-14). Do not apply this decision.\n",
    );
  });
});
