import { compileKind, isKind } from "@nikovirtala/ledger";
import { expect, it } from "vitest";
import { adrKind } from "./kind.js";

it("defines the decision kind with defineKind", () => {
  expect(isKind(adrKind)).toBe(true);
  expect(adrKind.name).toBe("decision");
  expect(adrKind.schema).toBe("decision/v1");
  expect(adrKind.sourceName).toBe("adr");
  expect(adrKind.layoutAt("docs/adr")).toMatchObject({
    root: "docs/adr",
    bodies: "decisions",
    events: "events",
  });
});

it("compiles, with exactly the 9 event types of decision/v1 (AC 2)", () => {
  expect(compileKind(adrKind).kind).toBe(adrKind);
  expect(Object.keys(adrKind.schemas)).toEqual(["decision/v1"]);
  expect(Object.keys(adrKind.schemas["decision/v1"]?.events ?? {}).sort()).toEqual([
    "accepted",
    "deprecated",
    "linked",
    "noted",
    "proposed",
    "rejected",
    "scoped",
    "superseded",
    "withdrawn",
  ]);
});

it("derives the terminal states rejected, withdrawn and superseded", () => {
  expect([...adrKind.machine.terminal].sort()).toEqual(["rejected", "superseded", "withdrawn"]);
});
