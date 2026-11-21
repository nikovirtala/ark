/** Property: every failure after the freeze is set leaves it set. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROPERTY_RUNS, play, world } from "./test-support/world.js";

describe("the freeze flag", () => {
  it(`stays set once a run sets it, whatever fails after it, until a person clears it (${PROPERTY_RUNS} sequences of up to 8 runs)`, async () => {
    await fc.assert(
      fc.asyncProperty(world, async (scripts) => {
        const trace = await play(scripts);
        for (const [i, run] of trace.runs.entries()) {
          // A run never clears the flag; only a person does, between runs.
          expect(run.clearsDuringRun, `run ${run.index}`).toBe(0);
          if (run.freezeSets > 0) {
            expect(run.frozenAtEnd, `run ${run.index}`).toBe(true);
            const next = trace.runs[i + 1];
            if (next && next.script.before !== "unfreeze") expect(next.frozenAtStart).toBe(true);
          }
          // A failed deploy, smoke check or task always ends with the flag set, when it could be written.
          const r = run.result;
          if (
            r !== "crashed" &&
            ["rolled-back", "rollback-failed", "task-failed"].includes(r.outcome) &&
            !run.script.freezeSetFails
          ) {
            expect(run.frozenAtEnd).toBe(true);
          }
          // And a refusal or a success never sets it.
          if (r !== "crashed" && ["refused", "check-failed", "succeeded"].includes(r.outcome))
            expect(run.freezeSets).toBe(0);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
