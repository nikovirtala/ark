import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileKind } from "../envelope/kind.js";
import type { Finding } from "../findings/finding.js";
import { MemoryTree } from "../git/tree.js";
import { classifyPath } from "../identity/layout.js";
import { exampleKind, exampleLayout } from "../testing/example-kind.js";
import { arbLogFixture, type LogFixture } from "../testing/log-fixture.js";
import {
  applyTamper,
  arbAppend,
  arbTamper,
  expectedRules,
  type TamperMutation,
} from "../testing/tamper.js";
import { verifySnapshots } from "./verify.js";

const kind = compileKind(exampleKind);
const fixtures = () => arbLogFixture({ kind: exampleKind, layout: exampleLayout });
const scopes = ["all", "changed"] as const;

const verify = (
  fixture: LogFixture,
  head: Record<string, string>,
  scope: "all" | "changed",
): Promise<Finding[]> =>
  verifySnapshots({
    kind,
    layout: fixture.layout,
    base: new MemoryTree(fixture.files),
    head: new MemoryTree(head),
    scope,
  });

/** The paths and subject a mutation touches. */
function targets(
  fixture: LogFixture,
  m: TamperMutation,
): { paths: string[]; subject: string | null } {
  const subjectOf = (path: string) => {
    const p = classifyPath(fixture.layout, path);
    return p.area === "event" ? p.subject : null;
  };
  switch (m.type) {
    case "modify-event":
    case "delete-event":
      return { paths: [m.path], subject: subjectOf(m.path) };
    case "rename-event":
      return { paths: [m.path, m.to], subject: subjectOf(m.path) };
    case "duplicate-event-id":
      return { paths: [m.path, m.from], subject: subjectOf(m.path) };
    case "edit-frozen-body":
    case "delete-frozen-body":
    case "wrong-hash":
    case "duplicate-subject-id":
      return { paths: [m.path], subject: m.subject };
  }
}

describe("verify properties (AC 9)", () => {
  for (const scope of scopes) {
    it(`finds nothing in a valid log, or after valid appends (scope ${scope})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fixtures().chain((f) => fc.tuple(fc.constant(f), arbAppend(f))),
          async ([fixture, append]) => {
            expect(await verify(fixture, { ...fixture.files }, scope)).toEqual([]);
            expect(Object.keys(append).some((p) => Object.hasOwn(fixture.files, p))).toBe(false);
            expect(await verify(fixture, { ...fixture.files, ...append }, scope)).toEqual([]);
          },
        ),
      );
    });
  }
});

describe("verify properties (AC 10)", () => {
  for (const scope of scopes) {
    it(`detects every mechanical tamper guaranteed in scope ${scope}`, async () => {
      const seen = new Set<TamperMutation["type"]>();
      await fc.assert(
        fc.asyncProperty(
          fixtures()
            .filter((f) => f.subjects.length > 0)
            .chain((f) => fc.tuple(fc.constant(f), arbTamper(f, { scope }))),
          async ([fixture, m]) => {
            seen.add(m.type);
            const findings = await verify(fixture, applyTamper(fixture.files, m), scope);
            const { paths, subject } = targets(fixture, m);
            const hit = findings.some(
              (f) =>
                f.severity === "error" &&
                expectedRules[m.type].includes(f.rule) &&
                ((f.file !== null && paths.includes(f.file)) || f.subject === subject),
            );
            expect(hit, JSON.stringify({ m, findings }, null, 2)).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
      expect([...seen].sort()).toEqual(Object.keys(expectedRules).sort());
    });
  }

  it("keeps duplicated event ids within one subject in scope changed", () => {
    fc.assert(
      fc.property(
        fixtures()
          .filter((f) => f.subjects.length > 0)
          .chain((f) => fc.tuple(fc.constant(f), arbTamper(f, { scope: "changed" }))),
        ([fixture, m]) => {
          if (m.type !== "duplicate-event-id") return;
          const dir = (p: string) => p.slice(0, p.lastIndexOf("/"));
          expect(dir(m.path)).toBe(dir(m.from));
          expect(Object.hasOwn(fixture.files, m.path)).toBe(false);
        },
      ),
    );
  });
});
