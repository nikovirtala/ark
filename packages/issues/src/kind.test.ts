import { adrKind } from "@nikovirtala/adr/kind";
import { compileKind, ENVELOPE_VERSION, isKind } from "@nikovirtala/ledger";
import { expect, it } from "vitest";
import * as kindModule from "./kind.js";
import { issueKind } from "./kind.js";

it("defines the issue kind with defineKind", () => {
  expect(isKind(issueKind)).toBe(true);
  expect(issueKind.name).toBe("issue");
  expect(issueKind.schema).toBe("issue/v1");
  expect(issueKind.sourceName).toBe("issues");
  expect(issueKind.anchorKeyword).toBe("issue");
  expect(issueKind.def.defaultRoot).toBe("docs/issues");
  expect(issueKind.def.body).toBe("mutable");
  expect(issueKind.def.states).toEqual(["open", "in-progress", "closed"]);
  expect(issueKind.layoutAt("docs/issues")).toMatchObject({
    root: "docs/issues",
    bodies: "items",
    events: "events",
  });
});

it("compiles on the ledger envelope, with the eleven event types of issue/v1", () => {
  expect(compileKind(issueKind).kind).toBe(issueKind);
  expect(() => compileKind(issueKind).compileAll()).not.toThrow();
  expect(ENVELOPE_VERSION).toBe("ledger/v1");
  expect(Object.keys(issueKind.schemas)).toEqual(["issue/v1"]);
  expect(Object.keys(issueKind.def.events)).toEqual([
    "opened",
    "started",
    "stopped",
    "closed",
    "reopened",
    "assigned",
    "labeled",
    "commented",
    "linked",
    "unlinked",
    "scoped",
  ]);
});

it("has no terminal state, so closed issues reopen", () => {
  expect(issueKind.machine.terminal).toEqual([]);
  expect(issueKind.machine.next("closed")).toContain("reopened");
});

it("numbers issues on opened and shows them with a ? prefix", () => {
  expect(issueKind.def.numbering?.on).toBe("opened");
  expect(issueKind.def.numbering?.format(42)).toBe("?42");
  expect(issueKind.def.numbering?.parse("?42")).toBe(42);
});

it("lints open and in-progress bodies and requires a done section in templates", () => {
  expect(issueKind.def.templates).toEqual({
    dir: "templates",
    nameField: "template",
    versionField: "template_version",
    lintIn: ["open", "in-progress"],
    requireSections: ["done"],
  });
  expect(issueKind.def.scope).toEqual({
    event: "scoped",
    activeIn: ["open", "in-progress"],
    requireMatchIn: ["in-progress"],
    keyword: "issue",
  });
});

it("exports the kind's values from @nikovirtala/issues/kind", () => {
  expect(Object.keys(kindModule).sort()).toEqual([
    "DEFAULT_ISSUE_OPTIONS",
    "ISSUE_REF",
    "ISSUE_STATES",
    "LABEL",
    "LOCAL_ID",
    "RELS",
    "RESOLUTIONS",
    "formatIssueNumber",
    "issueGraph",
    "issueKind",
    "labelPrefix",
    "parseIssueNumber",
  ]);
  expect(issueKind.def.options).toEqual({
    closeRequiresHuman: false,
    mcpCanClose: true,
    exclusive: [],
    sources: null,
  });
});

it("reads adr's kind through the @nikovirtala/adr/kind subpath", () => {
  expect(adrKind.name).toBe("decision");
  expect(adrKind.schema).toBe("decision/v1");
  expect(isKind(adrKind)).toBe(true);
});
