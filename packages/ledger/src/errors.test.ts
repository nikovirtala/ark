import { describe, expect, it } from "vitest";
import { runCli } from "./cli/run.js";
import {
  CommitFailedError,
  ConfigError,
  EventExistsError,
  FileExistsError,
  GitError,
  GitNotFoundError,
  GitVersionError,
  HookConflictError,
  HookShimError,
  InvalidArgumentError,
  KindDefinitionError,
  LedgerError,
  type LedgerErrorCode,
  NotARepositoryError,
  RefNotFoundError,
  SourceFetchError,
  UsageError,
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
    [new UsageError("unknown command"), "UsageError", "usage"],
    [new FileExistsError("docs/adr/a.md"), "FileExistsError", "file-exists"],
    [
      new HookConflictError("h exists", { written: [], unchanged: [], conflicts: [] }),
      "HookConflictError",
      "hook-conflict",
    ],
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
    expect(new FileExistsError("docs/adr/a.md")).toMatchObject({
      path: "docs/adr/a.md",
      message: "file already exists: docs/adr/a.md",
    });
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

describe("hook-conflict through runCli", () => {
  it("exits 2 with the whole message and the code in ark-error/v1", async () => {
    const result = {
      written: ["/r/.git/hooks/pre-push"],
      unchanged: [],
      conflicts: [
        { hook: "pre-commit", path: "/r/.git/hooks/pre-commit", reason: "foreign-hook", argv: [] },
      ],
    } as const;
    const message =
      "/r/.git/hooks/pre-commit exists and isn't an ark hook\nwrote: /r/.git/hooks/pre-push";
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      {
        name: "w",
        version: "0.0.0",
        summary: "widgets",
        commands: [
          {
            name: "hooks",
            summary: "install hooks",
            usage: "hooks",
            options: {},
            positionals: { min: 0, max: 0, names: [] },
            ref: "reject",
            run: () => {
              throw new HookConflictError(message, result);
            },
          },
        ],
      },
      {
        argv: ["--json", "hooks"],
        cwd: "/",
        env: {},
        stdout: {
          write: (s) => {
            stdout += s;
          },
        },
        stderr: {
          write: (s) => {
            stderr += s;
          },
        },
        interactive: false,
        stdoutIsTTY: false,
      },
    );
    expect(code).toBe(2);
    expect(stderr).toBe(`w: error: ${message}\n`);
    expect(JSON.parse(stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "hook-conflict", message },
    });
  });
});

describe("commit-failed through runCli", () => {
  const recovery = {
    staged: ["log/a.yaml"],
    messageFile: "/r/.git/ark/COMMIT_MSG",
    command: "git -C /r commit --cleanup=whitespace -F /r/.git/ark/COMMIT_MSG --only -- log/a.yaml",
    trailers: [],
  };
  const failed = new CommitFailedError({
    recovery,
    headline: "git commit failed (exit 1): hook says no",
    detail: "",
    rerun: "Don't run it again.",
    before: null,
    after: null,
    notes: ["attributed to agent x"],
  });

  async function run(error: CommitFailedError, argv: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      {
        name: "w",
        version: "0.0.0",
        summary: "widgets",
        commands: [
          {
            name: "add",
            summary: "add a widget",
            usage: "add",
            options: {},
            positionals: { min: 0, max: 0, names: [] },
            ref: "reject",
            run: () => {
              throw error;
            },
          },
        ],
      },
      {
        argv,
        cwd: "/",
        env: {},
        stdout: {
          write: (s) => {
            stdout += s;
          },
        },
        stderr: {
          write: (s) => {
            stderr += s;
          },
        },
        interactive: false,
        stdoutIsTTY: false,
      },
    );
    return { code, stdout, stderr };
  }

  it("prints the command's notes as warnings before the error, once each", async () => {
    // "Don't run it again." is already in the hint, so it isn't printed a second time.
    const e = failed.withNotes(["glob matches nothing", "Don't run it again."]);
    expect(e).toBeInstanceOf(CommitFailedError);
    expect(e.message).toBe(failed.message);
    expect(e.notes).toEqual([
      "glob matches nothing",
      "Don't run it again.",
      "attributed to agent x",
    ]);
    expect(failed.withNotes([])).toBe(failed);
    const out = await run(e, ["add"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toBe(
      `w: warning: glob matches nothing\nw: warning: attributed to agent x\nw: error: ${e.message}\n`,
    );
    const json = await run(e, ["--json", "add"]);
    expect(JSON.parse(json.stdout)).toEqual({
      format: "ark-error/v1",
      error: { code: "commit-failed", message: e.message },
      notes: ["glob matches nothing", "attributed to agent x"],
    });
  });
});
