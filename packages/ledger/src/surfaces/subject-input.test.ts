import { describe, expect, it } from "vitest";
import { NO_NUMBERING, type Numbering } from "../fold/numbering.js";
import { defineKind } from "../kind/define.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { resolveSubjectInput, type SubjectInput } from "./subject-input.js";

const A = "a7c2m9xd";
const B = "k3f9q8a1";
const DIGITS = "00000012";
const numbering: Numbering = {
  available: true,
  reason: null,
  ref: "refs/heads/main",
  commit: "0".repeat(40),
  byId: new Map([
    [A, 1],
    [B, 12],
    ["zzzzzzzz", 3],
  ]),
  byNumber: new Map([
    [1, A],
    [12, B],
    [3, "zzzzzzzz"],
  ]),
};
const subjects = new Set([A, B]);
const resolve = (input: string, o: { numbering?: Numbering; subjects?: Set<string> } = {}) =>
  resolveSubjectInput(input, {
    subjects: o.subjects ?? subjects,
    kind,
    numbering: o.numbering ?? numbering,
  });
const ok = (id: string): SubjectInput => ({ ok: true, id });
const no = (reason: string, input: string) => ({ ok: false, reason, input });

describe("resolveSubjectInput", () => {
  it.each([
    [A, ok(A)],
    [` ${A}\n`, ok(A)],
    ["1", ok(A)],
    ["W-12", ok(B)],
    ["w-0012", ok(B)],
    [" 12 ", ok(B)],
    ["2", no("not-found", "2")],
    // Numbered on main, but not in the tree being read.
    ["3", no("not-found", "3")],
    ["b7c2m9xd", no("not-found", "b7c2m9xd")],
    ["W-x", no("not-found", "W-x")],
    ["", no("malformed", "")],
    ["   ", no("malformed", "   ")],
    ["a".repeat(65), no("malformed", "a".repeat(65))],
    ["a\u0007b", no("malformed", "a\u0007b")],
    ["a\u0085b", no("malformed", "a\u0085b")],
    [`adr:${A}`, no("qualified", `adr:${A}`)],
    ["team:12", no("qualified", "team:12")],
  ])("%j", (input, expected) => {
    expect(resolve(input)).toEqual(expected);
  });

  it("accepts 64 characters after trimming", () => {
    expect(resolve(` ${"a".repeat(64)} `)).toEqual(no("not-found", ` ${"a".repeat(64)} `));
  });

  it("treats an 8-digit input as an id first, then as a number", () => {
    const withDigits = new Set([...subjects, DIGITS]);
    expect(resolve(DIGITS, { subjects: withDigits })).toEqual(ok(DIGITS));
    expect(resolve(DIGITS)).toEqual(ok(B));
  });

  it("reports numbers as unavailable without numbering, but still resolves ids", () => {
    const shallow = { ...NO_NUMBERING, reason: "shallow" as const };
    expect(resolve("12", { numbering: shallow })).toEqual(no("numbers-unavailable", "12"));
    expect(resolve("W-1", { numbering: NO_NUMBERING })).toEqual(no("numbers-unavailable", "W-1"));
    expect(resolve(A, { numbering: NO_NUMBERING })).toEqual(ok(A));
    expect(resolve("W-x", { numbering: NO_NUMBERING })).toEqual(no("not-found", "W-x"));
  });

  it("has no numbers for a kind without numbering", () => {
    const plain = defineKind({
      name: "plain",
      schema: "plain/v1",
      states: ["open"],
      events: { opened: { data: { type: "object" }, allowedIn: [], to: "open" } },
      initial: "opened",
      reduce: () => null,
      project: (s) => s.id,
      body: "none",
      layout: { bodies: null, events: "events" },
      defaultRoot: "plain",
      options: undefined,
    });
    expect(resolveSubjectInput("1", { subjects, kind: plain, numbering: NO_NUMBERING })).toEqual(
      no("not-found", "1"),
    );
  });
});
