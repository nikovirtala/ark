import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editorFor } from "./editor.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "issues-editor-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("editorFor", () => {
  it("is null without VISUAL or EDITOR", () => {
    expect(editorFor({}, { stdoutIsTTY: false })).toBeNull();
    expect(editorFor({ VISUAL: " ", EDITOR: "" }, { stdoutIsTTY: false })).toBeNull();
  });

  it("prefers VISUAL, passes the path as $1, and reports a failing editor", async () => {
    const dir = await tempDir();
    const visual = await script(dir, "visual", 'echo visual > "$1"');
    const editor = await script(dir, "editor", 'echo editor > "$1"');
    const file = join(dir, "it's a draft.md");
    expect(
      await editorFor({ VISUAL: visual, EDITOR: editor }, { stdoutIsTTY: false })?.(file),
    ).toBeNull();
    expect(await readFile(file, "utf8")).toBe("visual\n");
    const failing = await script(dir, "failing", "exit 3");
    expect(await editorFor({ EDITOR: failing }, { stdoutIsTTY: false })?.(file)).toBe(
      "the editor exited with status 3",
    );
  });
});
