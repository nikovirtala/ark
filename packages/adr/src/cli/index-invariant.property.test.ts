/**
 * The index invariant for random write paths under combined preconditions
 * (test-support/index-invariant.ts).
 */
import fc from "fast-check";
import { describe, it } from "vitest";
import { PATHS, type Precondition, runCase, skipOf } from "../test-support/index-invariant.js";

describe("the index invariant", { timeout: 120_000 }, () => {
  it("holds for random write paths under combined preconditions", async () => {
    // Preconditions that combine: "absent" and "stale-head" exclude each other, and "unborn"
    // stands alone (it rules out the committed seeds the others build on).
    const combinable = ["others", "subject", "auto"] as const;
    const arbCase = fc
      .record({
        path: fc.constantFrom(...PATHS),
        extra: fc.subarray([...combinable]),
        index: fc.constantFrom<Precondition | null>("stale-head", "absent", null),
      })
      .map(({ path, extra, index }) => ({
        path,
        pres: [...extra, ...(index === null ? [] : [index])].filter(
          (p) => skipOf(path, p) === undefined,
        ),
      }));
    await fc.assert(fc.asyncProperty(arbCase, runCase), { numRuns: 12 });
  });
});
