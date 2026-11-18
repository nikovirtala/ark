import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.js";
import { COMMIT_OPTIONS, collectHints, commitChoice, REDUNDANT_COMMIT_HINT } from "./commit.js";

const parse = (args: string[]) =>
  parseArgs({ args, options: COMMIT_OPTIONS, allowNegative: true, strict: true }).values;

describe("commitChoice", () => {
  it("hints that --commit isn't needed only when auto_commit already commits", () => {
    const hintsFor = (args: string[], autoCommit: boolean) => {
      const values = parse(args);
      const hints = collectHints(values);
      commitChoice(values, { autoCommit });
      commitChoice(values, { autoCommit });
      return [...hints];
    };
    expect(hintsFor(["--commit"], true)).toEqual([REDUNDANT_COMMIT_HINT]);
    expect(hintsFor(["--commit"], false)).toEqual([]);
    expect(hintsFor([], true)).toEqual([]);
    expect(hintsFor(["--no-commit"], true)).toEqual([]);
    // Values nobody collects hints for get none, and nothing fails.
    expect(commitChoice(parse(["--commit"]), { autoCommit: true }).commit).toBe(true);
  });
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
