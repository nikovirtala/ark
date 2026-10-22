import { describe, expect, it } from "vitest";
import { ACTOR_KEYS, ENVELOPE_KEYS, unknownFields } from "./types.js";

describe("envelope keys", () => {
  it("are in canonical order", () => {
    expect(ENVELOPE_KEYS).toEqual([
      "envelope",
      "kind",
      "schema",
      "id",
      "subject",
      "type",
      "at",
      "actor",
      "reason",
      "data",
    ]);
    expect(ACTOR_KEYS).toEqual(["kind", "name", "email", "agent", "on_behalf_of"]);
  });
});

describe("unknownFields", () => {
  it("keeps the other fields in insertion order", () => {
    const fields = unknownFields({ z: 1, kind: "k", a: [2], id: "x" }, ENVELOPE_KEYS);
    expect(fields).toEqual({ z: 1, a: [2] });
    expect(Object.keys(fields)).toEqual(["z", "a"]);
    expect(unknownFields({ kind: "k" }, ENVELOPE_KEYS)).toEqual({});
  });
});
