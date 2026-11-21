/** Property: a task failure never rolls back. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROPERTY_RUNS, play, world } from "./test-support/world.js";

describe("a failed deployment task", () => {
  it(`never rolls back, and a rollback only follows a failed deploy or smoke check (${PROPERTY_RUNS} sequences of up to 8 runs)`, async () => {
    await fc.assert(
      fc.asyncProperty(world, async (scripts) => {
        const trace = await play(scripts);
        for (const run of trace.runs) {
          const rolledBack = run.calls.some((c) => c.startsWith("rollback"));
          const r = run.result;
          if (r === "crashed" || r.outcome === "task-failed")
            expect(rolledBack, `run ${run.index}`).toBe(false);
          if (rolledBack) {
            expect(r === "crashed" ? "crashed" : r.outcome).toMatch(
              /^(rolled-back|rollback-failed)$/,
            );
            expect(run.calls).not.toContain("tasks");
          }
          // Tasks run only after the smoke checks passed.
          if (run.calls.includes("tasks"))
            expect(run.calls.indexOf("smoke")).toBeLessThan(run.calls.indexOf("tasks"));
        }
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});
