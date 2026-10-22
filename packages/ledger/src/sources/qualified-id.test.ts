import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { arbSubjectId } from "../testing/arbitraries.js";
import { formatQualifiedId, parseQualifiedId } from "./qualified-id.js";

describe("qualified ids", () => {
  it("parses bare and qualified ids", () => {
    expect(parseQualifiedId("k3f9q8a1")).toEqual({ source: null, id: "k3f9q8a1" });
    expect(parseQualifiedId("platform:k3f9q8a1")).toEqual({ source: "platform", id: "k3f9q8a1" });
  });

  it.each([
    "",
    "K3F9Q8A1",
    "k3f9q8a",
    "k3f9q8a1x",
    "k3f9q8ai",
    ":k3f9q8a1",
    "Platform:k3f9q8a1",
    "a:b:k3f9q8a1",
  ])("rejects %j", (s) => {
    expect(parseQualifiedId(s)).toBeNull();
  });

  it("round-trips through formatQualifiedId", () => {
    fc.assert(
      fc.property(
        fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,31}$/), { nil: null }),
        arbSubjectId(),
        (source, id) => {
          const q = { source, id };
          expect(parseQualifiedId(formatQualifiedId(q))).toEqual(q);
        },
      ),
    );
  });

  it("refuses to format an id that wouldn't parse back", () => {
    expect(() => formatQualifiedId({ source: "Bad", id: "k3f9q8a1" })).toThrow(
      InvalidArgumentError,
    );
    expect(() => formatQualifiedId({ source: null, id: "nope" })).toThrow(InvalidArgumentError);
  });
});
