import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exampleMachineKind as widget } from "./example-machine-kind.js";
import { applySemanticTamper, arbSemanticTamper } from "./semantic-tamper.js";
import { histories, verify, widgetData } from "./semantic-tamper-support.js";

describe("semantic tampers", () => {
  it("give an illegal freeze a matching hash, so only the transition is reported", async () => {
    await fc.assert(
      fc.asyncProperty(histories(), fc.gen(), async (h, g) => {
        const arb = arbSemanticTamper(h, {
          kind: widget,
          data: widgetData,
          only: ["illegal-transition"],
        });
        fc.pre(arb !== null);
        const m = g(() => arb);
        fc.pre(m.path.endsWith("-published.yaml"));
        const findings = await verify(widget, h, applySemanticTamper(h.files, m), "all");
        expect(findings.map((f) => [f.rule, f.file])).toEqual([["transition/illegal", m.path]]);
      }),
    );
  });
});
