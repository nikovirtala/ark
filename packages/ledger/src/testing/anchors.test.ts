import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../errors.js";
import { isSubjectId } from "../identity/ids.js";
import { anchorsInLine } from "../scope/anchors.js";
import { danglingAnchor } from "./anchors.js";

describe("danglingAnchor", () => {
  it("gives a src file whose one anchor names an id outside taken, the same for a seed", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.uniqueArray(fc.stringMatching(/^[0-9a-hjkmnp-tv-z]{8}$/), { maxLength: 5 }),
        (seed, ids) => {
          const first = danglingAnchor({ keyword: "adr", taken: new Set(), seed });
          const taken = new Set([...ids, first.id]);
          const a = danglingAnchor({ keyword: "adr", taken, seed });
          expect(danglingAnchor({ keyword: "adr", taken, seed })).toEqual(a);
          expect(isSubjectId(a.id)).toBe(true);
          expect(taken.has(a.id)).toBe(false);
          expect(a.path).toMatch(/^src\/[^/]+\.ts$/);
          expect(a.text).toBe(`// adr:${a.id}\n`);
          expect(anchorsInLine(a.text.trimEnd(), "adr")).toEqual([
            { source: null, id: a.id, column: 4 },
          ]);
        },
      ),
    );
  });

  it("rejects an invalid keyword or seed", () => {
    expect(() => danglingAnchor({ keyword: "A", taken: new Set(), seed: 1 })).toThrow(
      InvalidArgumentError,
    );
    expect(() => danglingAnchor({ keyword: "adr", taken: new Set(), seed: 0.5 })).toThrow(
      InvalidArgumentError,
    );
  });
});
