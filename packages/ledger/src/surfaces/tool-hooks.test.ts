import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookConflictError } from "../errors.js";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import {
  installToolHooks,
  printToolHooks,
  toolHookCommands,
  toolHooksResult,
  uninstallToolHooks,
} from "./tool-hooks.js";
import { openToolLog } from "./tool-log.js";

const SPEC = { tool: "widget", format: "widget-hooks/v1" } as const;

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = { "README.md": "x\n" }): Promise<TempRepo> {
  const r = await createTempRepo({ files });
  repos.push(r);
  return r;
}
const open = (r: TempRepo, root?: string) =>
  openToolLog({
    cwd: r.root,
    tool: "widget",
    kind,
    root: root ?? null,
    gitOptions: { env: r.env },
  });

const REGISTRATIONS = [
  { hook: "pre-commit", argv: ["hooks", "run", "pre-commit"] },
  { hook: "commit-msg", argv: ["hooks", "trailers", "{args}"] },
  {
    hook: "pre-push",
    argv: ["verify", "--base", "@{upstream}", "--ref", "HEAD", "--fetch-sources"],
  },
  { hook: "post-merge", argv: ["list", "--since", "ORIG_HEAD"] },
];

describe("toolHookCommands", () => {
  it("passes --root only when neither the repo config nor the default root finds it", async () => {
    const r = await repo();
    expect(toolHookCommands(await open(r), "widget")["pre-commit"]).toEqual([
      "hooks",
      "run",
      "pre-commit",
    ]);
    expect(toolHookCommands(await open(r, "other"), "widget")["commit-msg"]).toEqual([
      "--root",
      "other",
      "hooks",
      "trailers",
      "{args}",
    ]);
    const configured = await repo({ "widget.toml": '[log]\nroot = "other"\n' });
    expect(toolHookCommands(await open(configured), "widget")["post-merge"]).toEqual([
      "list",
      "--since",
      "ORIG_HEAD",
    ]);
  });
});

describe("installToolHooks, uninstallToolHooks and printToolHooks", () => {
  it("install writes the shims and lists them repo-relative in hook order", async () => {
    const r = await repo();
    const log = await open(r);
    const doc = await installToolHooks(log, SPEC);
    expect(doc).toEqual({
      format: "widget-hooks/v1",
      action: "install",
      written: [
        ".git/hooks/pre-commit",
        ".git/hooks/commit-msg",
        ".git/hooks/pre-push",
        ".git/hooks/post-merge",
      ],
      unchanged: [],
      registrations: REGISTRATIONS,
      snippet: null,
      trailers: [],
    });
    expect(await readFile(join(r.git.gitDir, "hooks/commit-msg"), "utf8")).toContain("widget");
    const again = await installToolHooks(log, SPEC);
    expect(again.written).toEqual([]);
    expect(again.unchanged).toHaveLength(4);
    const removed = await uninstallToolHooks(log, SPEC);
    expect(removed).toMatchObject({
      action: "uninstall",
      written: doc.written,
      registrations: REGISTRATIONS,
    });
  });

  it("install throws on a foreign hook after writing the rest", async () => {
    const r = await repo();
    await r.write(".git/hooks/pre-push", "#!/bin/sh\nexit 0\n");
    await expect(installToolHooks(await open(r), SPEC)).rejects.toBeInstanceOf(HookConflictError);
  });

  it("print gives the manager snippet of the tool's registrations", async () => {
    const r = await repo();
    const doc = printToolHooks(await open(r), SPEC, "lefthook");
    expect(doc).toMatchObject({ action: "print", written: [], registrations: REGISTRATIONS });
    expect(doc.snippet).toContain("widget hooks trailers");
  });

  it("toolHooksResult carries the trailers", async () => {
    const r = await repo();
    const doc = toolHooksResult(await open(r), SPEC, "trailers", null, {
      trailers: [["Widget", "aaaaaaaa"]],
    });
    expect(doc).toMatchObject({
      action: "trailers",
      snippet: null,
      trailers: [["Widget", "aaaaaaaa"]],
    });
  });
});
