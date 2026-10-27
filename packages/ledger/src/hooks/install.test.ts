import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookConflictError, HookShimError, InvalidArgumentError } from "../errors.js";
import { Git } from "../git/git.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  assertNoHookConflicts,
  installHooks,
  readHookRegistry,
  uninstallHooks,
} from "./install.js";
import { renderShim } from "./shim.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(o?: Parameters<typeof createTempRepo>[0]): Promise<TempRepo> {
  const r = await createTempRepo(o);
  repos.push(r);
  return r;
}

const verify = ["verify", "--staged"];
const push = ["verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"];
const hookPath = (r: TempRepo, hook: string) => join(r.root, ".git", "hooks", hook);
/** The shims the default commands write, in `HOOK_NAMES` order. */
const defaults = (r: TempRepo) => [hookPath(r, "pre-commit"), hookPath(r, "pre-push")];

describe("installHooks", () => {
  it("writes one shim for every tool, with an absolute path and mode 0755", async () => {
    const r = await repo();
    const a = await installHooks(r.git, { tool: "adr" });
    expect(a).toEqual({ written: defaults(r), unchanged: [], conflicts: [] });
    const b = await installHooks(r.git, { tool: "issues" });
    expect(b.written).toEqual(defaults(r));
    expect(await readHookRegistry(r.git)).toEqual([
      { tool: "adr", hook: "pre-commit", argv: verify },
      { tool: "issues", hook: "pre-commit", argv: verify },
      { tool: "adr", hook: "pre-push", argv: push },
      { tool: "issues", hook: "pre-push", argv: push },
    ]);
    const path = hookPath(r, "pre-commit");
    expect(await readFile(path, "utf8")).toBe(
      renderShim("pre-commit", [
        { tool: "adr", hook: "pre-commit", argv: verify },
        { tool: "issues", hook: "pre-commit", argv: verify },
      ]),
    );
    expect(await readFile(hookPath(r, "pre-push"), "utf8")).toBe(
      renderShim("pre-push", [
        { tool: "adr", hook: "pre-push", argv: push },
        { tool: "issues", hook: "pre-push", argv: push },
      ]),
    );
    for (const p of defaults(r)) expect((await stat(p)).mode & 0o777).toBe(0o755);
    expect(existsSync(hookPath(r, "commit-msg"))).toBe(false);
    expect(existsSync(hookPath(r, "post-merge"))).toBe(false);
  });

  it("is idempotent", async () => {
    const r = await repo();
    await installHooks(r.git, { tool: "adr" });
    await installHooks(r.git, { tool: "issues" });
    expect(await installHooks(r.git, { tool: "adr" })).toEqual({
      written: [],
      unchanged: defaults(r),
      conflicts: [],
    });
  });

  it("sets a tool's registrations to exactly its commands", async () => {
    const r = await repo();
    await installHooks(r.git, { tool: "adr" });
    await installHooks(r.git, { tool: "issues" });
    const moved = await installHooks(r.git, {
      tool: "adr",
      commands: { "commit-msg": ["trailers", "{args}"] },
    });
    expect(moved.written).toEqual([
      hookPath(r, "pre-commit"),
      hookPath(r, "commit-msg"),
      hookPath(r, "pre-push"),
    ]);
    expect(await readHookRegistry(r.git)).toEqual([
      { tool: "issues", hook: "pre-commit", argv: verify },
      { tool: "adr", hook: "commit-msg", argv: ["trailers", "{args}"] },
      { tool: "issues", hook: "pre-push", argv: push },
    ]);

    // A shim left without registrations is deleted.
    await installHooks(r.git, { tool: "issues", commands: { "post-merge": ["list"] } });
    expect(existsSync(hookPath(r, "pre-commit"))).toBe(false);
    expect(existsSync(hookPath(r, "pre-push"))).toBe(false);
    expect((await readHookRegistry(r.git)).map((x) => `${x.hook}:${x.tool}`)).toEqual([
      "commit-msg:adr",
      "post-merge:issues",
    ]);
  });

  it("never overwrites a foreign hook", async () => {
    const r = await repo();
    const path = hookPath(r, "pre-commit");
    await writeFile(path, "#!/bin/sh\nexec lint-staged\n");
    expect(await installHooks(r.git, { tool: "adr" })).toEqual({
      written: [hookPath(r, "pre-push")],
      unchanged: [],
      conflicts: [{ hook: "pre-commit", path, reason: "foreign-hook", argv: verify }],
    });
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\nexec lint-staged\n");
    expect(await readHookRegistry(r.git)).toEqual([{ tool: "adr", hook: "pre-push", argv: push }]);
  });

  it("writes nothing when core.hooksPath is set", async () => {
    const r = await repo();
    await r.git.run(["config", "core.hooksPath", ".husky"]);
    const result = await installHooks(r.git, { tool: "adr" });
    expect(result).toEqual({
      written: [],
      unchanged: [],
      conflicts: [
        {
          hook: "pre-commit",
          path: join(r.root, ".husky", "pre-commit"),
          reason: "hooks-path",
          argv: verify,
        },
        {
          hook: "pre-push",
          path: join(r.root, ".husky", "pre-push"),
          reason: "hooks-path",
          argv: push,
        },
      ],
    });
    expect(existsSync(join(r.root, ".husky"))).toBe(false);
  });

  it("throws HookShimError for a corrupted shim", async () => {
    const r = await repo();
    await installHooks(r.git, { tool: "adr" });
    const path = hookPath(r, "pre-commit");
    await writeFile(path, (await readFile(path, "utf8")).replace('"argv":[', '"argv":'));
    await expect(installHooks(r.git, { tool: "issues" })).rejects.toMatchObject({
      name: "HookShimError",
      code: "hook-shim",
      path,
    });
    await expect(readHookRegistry(r.git)).rejects.toBeInstanceOf(HookShimError);
  });

  it("uses the common hooks directory from a linked worktree", async () => {
    const r = await repo({ files: { "a.txt": "a\n" } });
    const wt = join(r.root, "..", "wt");
    await r.git.run(["worktree", "add", "-q", wt]);
    const linked = await Git.open(wt, r.git.options);
    expect((await installHooks(linked, { tool: "adr" })).written).toEqual(defaults(r));
    // A git-directory-only handle reads the same registry.
    const gitDirOnly = await Git.openGitDir(r.git.gitDir, r.git.options);
    expect(await readHookRegistry(gitDirOnly)).toEqual([
      { tool: "adr", hook: "pre-commit", argv: verify },
      { tool: "adr", hook: "pre-push", argv: push },
    ]);
  });

  it("rejects misuse", async () => {
    const r = await repo();
    await expect(installHooks(r.git, { tool: "A" })).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      installHooks(r.git, { tool: "adr", commands: { "pre-commit": ["a\nb"] } }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      installHooks(r.git, { tool: "adr", commands: { "pre-rebase": ["x"] } as never }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    const bare = await repo({ bare: true });
    await expect(installHooks(bare.git, { tool: "adr" })).rejects.toThrow(
      "operation needs a work tree",
    );
    expect(existsSync(hookPath(r, "pre-commit"))).toBe(false);
  });
});

describe("assertNoHookConflicts", () => {
  const conflictOf = (f: () => void): HookConflictError => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(HookConflictError);
      return e as HookConflictError;
    }
    throw new Error("no HookConflictError");
  };

  it("is quiet without conflicts", async () => {
    const r = await repo();
    const result = await installHooks(r.git, { tool: "adr" });
    expect(() => assertNoHookConflicts(result, { tool: "adr" })).not.toThrow();
  });

  it("names a foreign hook, the line to add to it, and what was written", async () => {
    const r = await repo();
    const path = hookPath(r, "pre-commit");
    await writeFile(path, "#!/bin/sh\nexec lint-staged\n");
    const result = await installHooks(r.git, {
      tool: "adr",
      commands: { "pre-commit": ["verify", "--staged"], "commit-msg": ["trailers", "{args}"] },
    });
    const e = conflictOf(() => assertNoHookConflicts(result, { tool: "adr" }));
    expect(e.code).toBe("hook-conflict");
    expect(e.result).toBe(result);
    expect(e.message).toBe(
      [
        `${path} exists and isn't an ark hook; add 'adr verify --staged' to it, or move it away and run adr hooks install again`,
        `wrote: ${hookPath(r, "commit-msg")}`,
      ].join("\n"),
    );
  });

  it("passes the hook's arguments in the foreign-hook line", async () => {
    const r = await repo();
    const path = hookPath(r, "commit-msg");
    await writeFile(path, "#!/bin/sh\n");
    const result = await installHooks(r.git, {
      tool: "commitlint",
      commands: { "commit-msg": ["--edit", "{args}"] },
    });
    const e = conflictOf(() => assertNoHookConflicts(result, { tool: "commitlint" }));
    expect(e.message).toBe(
      `${path} exists and isn't an ark hook; add 'commitlint --edit "$@"' to it, or move it away and run commitlint hooks install again`,
    );
  });

  it("says once that core.hooksPath is set, with nothing written", async () => {
    const r = await repo();
    await r.git.run(["config", "core.hooksPath", ".husky"]);
    const result = await installHooks(r.git, { tool: "adr" });
    expect(result.conflicts).toHaveLength(2);
    const e = conflictOf(() => assertNoHookConflicts(result, { tool: "adr" }));
    expect(e.message).toBe(
      "core.hooksPath is set, so another tool manages git hooks; add the commands from 'adr hooks print --manager lefthook|husky|pre-commit' to it",
    );
  });
});

describe("uninstallHooks", () => {
  it("removes a tool's lines and deletes shims left empty", async () => {
    const r = await repo();
    await installHooks(r.git, { tool: "adr" });
    await installHooks(r.git, { tool: "issues" });
    expect(await uninstallHooks(r.git, { tool: "adr" })).toEqual({
      written: defaults(r),
      unchanged: [],
      conflicts: [],
    });
    expect(await readHookRegistry(r.git)).toEqual([
      { tool: "issues", hook: "pre-commit", argv: verify },
      { tool: "issues", hook: "pre-push", argv: push },
    ]);
    expect((await uninstallHooks(r.git, { tool: "adr" })).written).toEqual([]);
    expect((await uninstallHooks(r.git, { tool: "issues" })).written).toEqual(defaults(r));
    for (const p of defaults(r)) expect(existsSync(p)).toBe(false);
  });

  it("leaves foreign hooks alone", async () => {
    const r = await repo();
    const path = hookPath(r, "pre-commit");
    await writeFile(path, "#!/bin/sh\n");
    expect(await uninstallHooks(r.git, { tool: "adr" })).toEqual({
      written: [],
      unchanged: [],
      conflicts: [],
    });
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\n");
  });
});
