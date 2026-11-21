/** Property: a task in the ledger never runs twice. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROPERTY_RUNS, play, TASK_IDS, world } from "./test-support/world.js";

describe("a deployment task in the ledger", () => {
  it(`never runs again, and runs to success at most once (${PROPERTY_RUNS} sequences of up to 8 runs)`, async () => {
    await fc.assert(
      fc.asyncProperty(world, async (scripts) => {
        const trace = await play(scripts);
        for (const run of trace.runs) {
          for (const id of run.doneAtStart) {
            expect(
              run.calls.filter((c) => c.endsWith(` ${id}`)),
              `run ${run.index}, ${id}`,
            ).toEqual([]);
          }
        }
        for (const id of TASK_IDS) {
          const successes = trace.ledger.attemptsLog.filter(
            (a) => a.id === id && a.outcome === "succeeded",
          );
          expect(successes.length, id).toBeLessThanOrEqual(1);
          expect(trace.ledger.done.has(id)).toBe(successes.length === 1);
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
