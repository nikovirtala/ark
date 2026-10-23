import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { COMMIT_OPTIONS, commitChoice } from "./commit.js";

const parse = (args: string[]) =>
  parseArgs({ args, options: COMMIT_OPTIONS, allowNegative: true, strict: true }).values;

describe("commitChoice", () => {
  it("takes --commit/--no-commit when given, else the auto-commit setting", () => {
    expect(commitChoice(parse([]), { autoCommit: false })).toEqual({
      commit: false,
      message: null,
    });
    expect(commitChoice(parse([]), { autoCommit: true })).toEqual({ commit: true, message: null });
    expect(commitChoice(parse(["--commit"]), { autoCommit: false }).commit).toBe(true);
    expect(commitChoice(parse(["--no-commit"]), { autoCommit: true }).commit).toBe(false);
  });

  it("returns the checked --message", () => {
    expect(
      commitChoice(parse(["--commit", "-m", " fix: x\n\nwhy\n"]), { autoCommit: false }),
    ).toEqual({ commit: true, message: "fix: x\n\nwhy" });
    expect(commitChoice(parse(["--message", "fix: y"]), { autoCommit: true })).toEqual({
      commit: true,
      message: "fix: y",
    });
  });

  it("refuses --message without a commit, with --no-commit, or empty", () => {
    const refuse = (args: string[], autoCommit: boolean) => () =>
      commitChoice(parse(args), { autoCommit });
    expect(refuse(["-m", "x"], false)).toThrow(UsageError);
    expect(refuse(["-m", "x"], false)).toThrow(
      "--message needs --commit (or [policy] auto_commit = true)",
    );
    expect(refuse(["-m", "x", "--no-commit"], true)).toThrow(
      "--message can't be used with --no-commit",
    );
    expect(refuse(["--commit", "-m", "  "], false)).toThrow("the commit message is empty");
  });
});
