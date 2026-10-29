import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exampleMachineKind as widget } from "./example-machine-kind.js";
import {
  applySemanticTamper,
  arbSemanticTamper,
  type SemanticTamper,
  semanticExpectedRules,
} from "./semantic-tamper.js";
import { histories, scopes, verify, widgetData } from "./semantic-tamper-support.js";

describe("semantic tampers", () => {
  for (const type of Object.keys(semanticExpectedRules) as SemanticTamper["type"][]) {
    it(`detect ${type} in both scopes`, async () => {
      await fc.assert(
        fc.asyncProperty(histories(), fc.gen(), async (h, g) => {
          const arb = arbSemanticTamper(h, { kind: widget, data: widgetData, only: [type] });
          fc.pre(arb !== null);
          const m = g(() => arb);
          expect(m.type).toBe(type);
          const head = applySemanticTamper(h.files, m);
          for (const scope of scopes) {
            const findings = await verify(widget, h, head, scope);
            const hit = findings.some(
              (f) =>
                f.severity === "error" &&
                semanticExpectedRules[type].includes(f.rule) &&
                f.file === m.path,
            );
            expect(hit, JSON.stringify({ m, findings }, null, 2)).toBe(true);
          }
        }),
      );
    });
  }
});
