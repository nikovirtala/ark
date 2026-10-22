import { describe, expect, it } from "vitest";
import {
  ConfigError,
  EventExistsError,
  GitError,
  GitNotFoundError,
  GitVersionError,
  HookShimError,
  InvalidArgumentError,
  KindDefinitionError,
  LedgerError,
  type LedgerErrorCode,
  NotARepositoryError,
  RefNotFoundError,
  SourceFetchError,
  VerifyUsageError,
} from "./errors.js";

describe("error classes", () => {
  const cases: readonly [LedgerError, string, LedgerErrorCode][] = [
    [new LedgerError("ulid-overflow", "ulid overflow"), "LedgerError", "ulid-overflow"],
    [new InvalidArgumentError("bad"), "InvalidArgumentError", "invalid-argument"],
    [new ConfigError("bad"), "ConfigError", "config"],
    [new VerifyUsageError("bad"), "VerifyUsageError", "verify-usage"],
    [new RefNotFoundError("main"), "RefNotFoundError", "ref-not-found"],
    [new GitNotFoundError("git"), "GitNotFoundError", "git-not-found"],
    [new NotARepositoryError("/tmp"), "NotARepositoryError", "not-a-repository"],
    [new GitVersionError("2.30.0"), "GitVersionError", "git-version"],
    [
      new GitError("failed", { args: ["status"], exitCode: 1, stderr: "" }),
      "GitError",
      "git-failed",
    ],
    [
      new GitError("timed out", { code: "git-timeout", args: [], exitCode: null, stderr: "" }),
      "GitError",
      "git-timeout",
    ],
    [new EventExistsError("a.yaml"), "EventExistsError", "event-exists"],
    [new KindDefinitionError("widget", "bad"), "KindDefinitionError", "kind-definition"],
    [new SourceFetchError("platform", "bad"), "SourceFetchError", "source-fetch"],
    [new HookShimError(".git/hooks/pre-commit", "bad"), "HookShimError", "hook-shim"],
  ];

  it.each(cases)("%s has its name and code and is a LedgerError", (error, name, code) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LedgerError);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.message).not.toMatch(/\n|\.$/);
  });

  it("carries the extra fields", () => {
    expect(new ConfigError("bad", { file: "adr.toml", line: 3 })).toMatchObject({
      file: "adr.toml",
      line: 3,
    });
    expect(new ConfigError("bad")).toMatchObject({ file: null, line: null });
    expect(new RefNotFoundError("main").ref).toBe("main");
    expect(new GitNotFoundError("/usr/bin/git").binary).toBe("/usr/bin/git");
    expect(new NotARepositoryError("/tmp").cwd).toBe("/tmp");
    expect(new GitVersionError("2.30.0")).toMatchObject({ found: "2.30.0", required: "2.32.0" });
    expect(
      new GitError("failed", { args: ["log"], exitCode: 128, stderr: "fatal: x" }),
    ).toMatchObject({ args: ["log"], exitCode: 128, stderr: "fatal: x" });
    expect(new EventExistsError("a.yaml").path).toBe("a.yaml");
    expect(new KindDefinitionError("widget", "bad").kind).toBe("widget");
    expect(new SourceFetchError("platform", "bad", "fatal: y")).toMatchObject({
      source: "platform",
      stderr: "fatal: y",
    });
    expect(new HookShimError("h", "bad").path).toBe("h");
  });

  it("sets cause when wrapping another error", () => {
    const cause = new Error("spawn git ENOENT");
    expect(new GitNotFoundError("git", { cause }).cause).toBe(cause);
    expect(new InvalidArgumentError("bad", { cause }).cause).toBe(cause);
  });

  it("distinguishes subclasses", () => {
    expect(new InvalidArgumentError("bad")).not.toBeInstanceOf(ConfigError);
  });
});
