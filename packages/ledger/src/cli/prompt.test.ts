import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type CliIO, processIO, readLineFrom } from "./output.js";
import { confirm } from "./prompt.js";

function fakeIO(o: { interactive?: boolean; answers?: readonly (string | null)[] | null } = {}) {
  const err: string[] = [];
  const answers = o.answers === undefined || o.answers === null ? [] : [...o.answers];
  const io: CliIO = {
    argv: [],
    cwd: "/",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: (s) => void err.push(s) },
    interactive: o.interactive ?? true,
    stdoutIsTTY: o.interactive ?? true,
    ...(o.answers === null ? {} : { readLine: async () => answers.shift() ?? null }),
  };
  return { io, err };
}

describe("confirm", () => {
  const Q = "Copy the scope? [y/N] ";

  it.each([
    ["y", true],
    ["YES", true],
    [" yes ", true],
    ["Y", true],
    ["n", false],
    ["", false],
    ["yep", false],
    [null, false],
  ])("answers %j as %s", async (answer, expected) => {
    const { io, err } = fakeIO({ answers: [answer] });
    expect(await confirm(io, Q, { json: false })).toBe(expected);
    expect(err).toEqual([Q]);
  });

  it("never asks under --json, without a terminal or without readLine", async () => {
    for (const [o, json] of [
      [{ answers: ["y"] }, true],
      [{ answers: ["y"], interactive: false }, false],
      [{ answers: null }, false],
    ] as const) {
      const { io, err } = fakeIO(o);
      expect(await confirm(io, Q, { json })).toBe(false);
      expect(err).toEqual([]);
    }
  });
});

describe("readLine", () => {
  it("is provided by processIO", () => {
    expect(typeof processIO().readLine).toBe("function");
  });

  it("returns the first line, then null once the stream closes", async () => {
    const input = new PassThrough();
    const first = readLineFrom(input);
    input.write("yes\nmore\n");
    expect(await first).toBe("yes");
    const second = readLineFrom(input);
    input.end();
    expect(await second).toBeNull();
  });

  it("returns null when the stream closes before a line", async () => {
    const input = new PassThrough();
    const line = readLineFrom(input);
    input.end();
    expect(await line).toBeNull();
  });
});
