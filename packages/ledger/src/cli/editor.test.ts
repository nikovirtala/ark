import { fstatSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editorFromEnv } from "./editor.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ledger-editor-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("editorFromEnv", () => {
  it("is null without VISUAL or EDITOR", () => {
    expect(editorFromEnv({}, { stdoutIsTTY: false })).toBeNull();
    expect(editorFromEnv({ VISUAL: " ", EDITOR: "" }, { stdoutIsTTY: true })).toBeNull();
  });

  it("prefers VISUAL and passes the path as $1", async () => {
    const dir = await tempDir();
    const visual = await script(dir, "visual", 'echo visual > "$1"');
    const editor = await script(dir, "editor", 'echo editor > "$1"');
    const file = join(dir, "draft.md");
    expect(
      await editorFromEnv({ VISUAL: visual, EDITOR: editor }, { stdoutIsTTY: false })?.(file),
    ).toBeNull();
    expect(await readFile(file, "utf8")).toBe("visual\n");
  });

  it("ends the failure note with failureSuffix, or with nothing without one", async () => {
    const dir = await tempDir();
    const editor = await script(dir, "editor", "exit 3");
    expect(await editorFromEnv({ EDITOR: editor }, { stdoutIsTTY: false })?.("/x")).toBe(
      "the editor exited with status 3",
    );
    expect(
      await editorFromEnv(
        { EDITOR: editor },
        { stdoutIsTTY: false, failureSuffix: "; the draft is staged as rendered" },
      )?.("/x"),
    ).toBe("the editor exited with status 3; the draft is staged as rendered");
    const killer = await script(dir, "killer", "kill -TERM $$");
    expect(
      await editorFromEnv({ EDITOR: killer }, { stdoutIsTTY: false, failureSuffix: "!" })?.("/x"),
    ).toBe("the editor was killed by SIGTERM!");
  });

  it("sends the editor's stdout to stderr without a TTY, and inherits it with one", async () => {
    const dir = await tempDir();
    const out = join(dir, "same.txt");
    // Whether the editor's fd 1 and fd 2 are the same file.
    const editor = await script(
      dir,
      "editor",
      `if [ /dev/fd/1 -ef /dev/fd/2 ]; then echo same > '${out}'; else echo apart > '${out}'; fi`,
    );
    expect(await editorFromEnv({ EDITOR: editor }, { stdoutIsTTY: false })?.("/x")).toBeNull();
    expect(await readFile(out, "utf8")).toBe("same\n");
    const [a, b] = [fstatSync(1), fstatSync(2)];
    const parentSame = a.dev === b.dev && a.ino === b.ino;
    expect(await editorFromEnv({ EDITOR: editor }, { stdoutIsTTY: true })?.("/x")).toBeNull();
    expect(await readFile(out, "utf8")).toBe(parentSame ? "same\n" : "apart\n");
  });
});
