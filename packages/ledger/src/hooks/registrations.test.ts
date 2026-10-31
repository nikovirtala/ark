import { describe, expect, it } from "vitest";
import { hookRegistrations } from "./registrations.js";

describe("hookRegistrations", () => {
  it("lists the hooks in hook order, whatever the map's key order", () => {
    expect(
      hookRegistrations({
        "post-merge": ["list"],
        "pre-push": ["verify"],
        "commit-msg": ["hooks", "trailers", "{args}"],
        "pre-commit": ["hooks", "run", "pre-commit"],
      }),
    ).toEqual([
      { hook: "pre-commit", argv: ["hooks", "run", "pre-commit"] },
      { hook: "commit-msg", argv: ["hooks", "trailers", "{args}"] },
      { hook: "pre-push", argv: ["verify"] },
      { hook: "post-merge", argv: ["list"] },
    ]);
  });

  it("leaves out the hooks without a command", () => {
    expect(hookRegistrations({ "pre-push": ["verify"], "pre-commit": ["x"] })).toEqual([
      { hook: "pre-commit", argv: ["x"] },
      { hook: "pre-push", argv: ["verify"] },
    ]);
    expect(hookRegistrations({})).toEqual([]);
  });
});
