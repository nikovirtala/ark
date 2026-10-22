import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSubjectId, newSubjectId } from "./ids.js";
import { createUlidFactory } from "./ulid.js";

describe("subject ids", () => {
  it("are 8 lowercase Crockford chars from 5 random bytes", () => {
    expect(newSubjectId((b) => b.fill(0))).toBe("00000000");
    expect(newSubjectId((b) => b.fill(255))).toBe("zzzzzzzz");
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 5, maxLength: 5 }), (bytes) => {
        const id = newSubjectId((b) => b.set(bytes));
        expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
        expect(isSubjectId(id)).toBe(true);
      }),
    );
  });

  it("are pairwise distinct while the ULID clock is frozen", () => {
    const nextUlid = createUlidFactory({ now: () => 1_760_000_000_000 });
    const ids = new Set<string>();
    const ulids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(newSubjectId());
      ulids.add(nextUlid());
    }
    expect(ids.size).toBe(10_000);
    expect(ulids.size).toBe(10_000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
  });

  it("rejects anything else", () => {
    for (const s of ["K3F9Q8A1", "k3f9q8a", "k3f9q8a1x", "k3f9q8i1", "k3f9q8u1", "", 12345678]) {
      expect(isSubjectId(s)).toBe(false);
    }
    expect(isSubjectId("k3f9q8a1")).toBe(true);
  });
});
