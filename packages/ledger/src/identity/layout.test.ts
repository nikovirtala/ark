import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigError, InvalidArgumentError } from "../errors.js";
import { arbAt, arbEventType, arbSlug, arbSubjectId, arbUlid } from "../testing/arbitraries.js";
import { bodyFileName, eventFileName } from "./files.js";
import { classifyPath, eventDir, eventPath, type LogLayout, normalizeLayout } from "./layout.js";

const adr: LogLayout = { root: "docs/adr", bodies: "decisions", events: "events" };

describe("normalizeLayout", () => {
  it("applies defaults and strips ./ and trailing slashes", () => {
    expect(normalizeLayout({ root: "docs/issues" })).toEqual({
      root: "docs/issues",
      bodies: null,
      events: "events",
    });
    expect(normalizeLayout({ root: "./docs/adr/", bodies: "decisions/", events: "./ev" })).toEqual({
      root: "docs/adr",
      bodies: "decisions",
      events: "ev",
    });
  });

  it("drops . segments anywhere, so the layout still matches tree paths", () => {
    const l = normalizeLayout({ root: "./docs/./adr/.", bodies: "decisions/.", events: "./ev/./" });
    expect(l).toEqual({ root: "docs/adr", bodies: "decisions", events: "ev" });
    expect(classifyPath(l, "docs/adr/ev/a7c2m9xd/x.yaml")).toMatchObject({ area: "event" });
  });

  it.each([
    ["an absolute root", { root: "/docs/adr" }],
    ["a .. segment", { root: "docs/../adr" }],
    ["an empty segment", { root: "docs//adr" }],
    ["an empty root", { root: "" }],
    ["a root of .", { root: "." }],
    ["a root of only . segments", { root: "./." }],
    ["an events of .", { root: "docs", events: "." }],
    ["a bodies of .", { root: "docs", bodies: "./." }],
    ["a backslash", { root: "docs\\adr" }],
    ["an absolute events", { root: "docs", events: "/events" }],
    ["a .. bodies", { root: "docs", bodies: "../x" }],
    ["events equal to bodies", { root: "docs", bodies: "events" }],
    ["events equal to bodies after normalizing", { root: "docs", bodies: "./x/", events: "x" }],
    ["events equal to bodies after dropping .", { root: "docs", bodies: "x/.", events: "./x" }],
  ])("rejects %s with ConfigError", (_, layout) => {
    expect(() => normalizeLayout(layout)).toThrow(ConfigError);
  });
});

describe("paths", () => {
  it("builds event dirs and paths", () => {
    expect(eventDir(adr, "a7c2m9xd")).toBe("docs/adr/events/a7c2m9xd");
    expect(
      eventPath(adr, {
        subject: "a7c2m9xd",
        at: "2026-03-14T12:02:11Z",
        id: "01JAB3K9Z6Q8M2X7FQ0V4TQ8A1",
        type: "accepted",
      }),
    ).toBe("docs/adr/events/a7c2m9xd/20260314T120211Z-q8a1-accepted.yaml");
    expect(() => eventDir(adr, "NOTANID")).toThrow(InvalidArgumentError);
  });

  it("classifies paths the way they are built", () => {
    fc.assert(
      fc.property(
        fc.record({ subject: arbSubjectId(), at: arbAt(), id: arbUlid(), type: arbEventType() }),
        arbSlug(),
        (e, slug) => {
          expect(classifyPath(adr, eventPath(adr, e))).toEqual({
            area: "event",
            subject: e.subject,
            file: eventFileName(e),
          });
          const body = bodyFileName(e.subject, slug);
          expect(classifyPath(adr, `docs/adr/decisions/${body}`)).toEqual({
            area: "body",
            file: body,
          });
        },
      ),
    );
  });

  it("classifies everything else", () => {
    expect(classifyPath(adr, "docs/adr/events/NOTANID/x.yaml")).toEqual({
      area: "event",
      subject: null,
      file: "x.yaml",
    });
    expect(classifyPath(adr, "docs/adr/events/README.md")).toEqual({
      area: "event",
      subject: null,
      file: "README.md",
    });
    expect(classifyPath(adr, "docs/adr/events/k3f9q8a1/.gitkeep")).toEqual({
      area: "event",
      subject: "k3f9q8a1",
      file: ".gitkeep",
    });
    expect(classifyPath(adr, "docs/adr/decisions/sub/x.md")).toEqual({
      area: "body",
      file: "sub/x.md",
    });
    expect(classifyPath(adr, "docs/adr/template.md")).toEqual({ area: "log-other" });
    expect(classifyPath(adr, "docs/adr")).toEqual({ area: "outside" });
    expect(classifyPath(adr, "docs/adr-other/x")).toEqual({ area: "outside" });
    const noBodies = normalizeLayout({ root: "log" });
    expect(classifyPath(noBodies, "log/decisions/x.md")).toEqual({ area: "log-other" });
  });
});
