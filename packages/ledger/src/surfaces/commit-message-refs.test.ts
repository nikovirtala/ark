import { describe, expect, it } from "vitest";
import { normalizeLayout } from "../identity/layout.js";
import { stagedEventRefs } from "./commit-message.js";

const layout = normalizeLayout({ root: "docs/adr", bodies: "decisions" });
const A = "a7c2m9xd";
const B = "b3ny9n1w";
const ev = (subject: string, file: string) => `docs/adr/events/${subject}/${file}`;

describe("stagedEventRefs", () => {
  it("gives the event files' refs sorted by path, deduplicated by subject and type", () => {
    expect(
      stagedEventRefs(layout, [
        ev(B, "20261031T120000Z-aaaa-created.yaml"),
        ev(A, "20261031T120001Z-bbbb-noted.yaml"),
        ev(A, "20261031T120000Z-cccc-created.yaml"),
        ev(A, "20261031T120002Z-dddd-noted.yaml"),
        ev(A, "20261031T120002Z-dddd-noted.yaml"),
      ]),
    ).toEqual([
      { subject: A, type: "created" },
      { subject: A, type: "noted" },
      { subject: B, type: "created" },
    ]);
  });

  it("skips files that aren't yaml, nested files, bad names and paths outside the events", () => {
    expect(
      stagedEventRefs(layout, [
        ev(A, "20261031T120000Z-aaaa-created.md"),
        ev(A, "nested/20261031T120000Z-aaaa-created.yaml"),
        ev(A, "notes.yaml"),
        ev("not-an-id", "20261031T120000Z-aaaa-created.yaml"),
        "docs/adr/events/20261031T120000Z-aaaa-created.yaml",
        "docs/adr/decisions/a7c2m9xd.yaml",
        "src/20261031T120000Z-aaaa-created.yaml",
        // A .yml name passes the filter, but isn't an event file name.
        ev(A, "20261031T120000Z-aaaa-created.yml"),
      ]),
    ).toEqual([]);
  });
});
