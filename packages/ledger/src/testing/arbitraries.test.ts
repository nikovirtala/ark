import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatEventFileName, isEventType, parseEventFileName } from "../identity/files.js";
import { isSubjectId } from "../identity/ids.js";
import { isAt } from "../identity/time.js";
import { isUlid } from "../identity/ulid.js";
import {
  arbAt,
  arbEventFileName,
  arbEventType,
  arbSlug,
  arbSubjectId,
  arbUlid,
} from "./arbitraries.js";

describe("identity arbitraries", () => {
  it("produce values the validators accept", () => {
    fc.assert(fc.property(arbSubjectId(), (id) => isSubjectId(id)));
    fc.assert(fc.property(arbUlid(), (id) => isUlid(id)));
    fc.assert(fc.property(arbAt(), (at) => isAt(at)));
    fc.assert(fc.property(arbEventType(), (t) => isEventType(t)));
    fc.assert(
      fc.property(arbEventFileName(), (n) => {
        expect(parseEventFileName(formatEventFileName(n))).toEqual(n);
      }),
    );
    fc.assert(
      fc.property(arbSlug(), (s) => s.length <= 60 && /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(s)),
    );
  });
});
