/** Property: no sequence of step outcomes deploys while frozen. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROPERTY_RUNS, play, world } from "./test-support/world.js";

describe("a frozen pipeline", () => {
  it(`deploys, smokes, runs tasks and rolls back nothing, whatever the steps would do (${PROPERTY_RUNS} sequences of up to 8 runs)`, async () => {
    await fc.assert(
      fc.asyncProperty(world, async (scripts) => {
        const trace = await play(scripts);
        for (const run of trace.runs.filter((r) => r.frozenAtStart)) {
          expect(run.calls, `run ${run.index}`).toEqual([]);
          expect(run.result === "crashed" ? "crashed" : run.result.outcome).toBe("frozen");
          expect(run.freezeSets).toBe(0);
        }
        // And a deploy only ever happens in a run that found the flag clear.
        for (const run of trace.runs.filter((r) => r.calls.includes("deploy")))
          expect(run.frozenAtStart).toBe(false);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
