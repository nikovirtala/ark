import { describe, expect, it } from "vitest";
import { SOURCE } from "./tools.js";

describe("SOURCE", () => {
  it("is the source-name rule, anchored", () => {
    expect(SOURCE).toEqual({ type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" });
  });
});
