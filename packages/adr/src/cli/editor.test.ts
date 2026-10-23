import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TempRepo } from "@nikovirtala/ledger/testing";
import { afterEach, describe, expect, it } from "vitest";
import { cliRepo, NYGARD_SECTIONS, runAdr } from "../test-support/cli.js";
import { editorFor } from "./editor.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "adr-editor-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** An executable `sh` script in `dir`; returns its path. */
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

  it("prefers VISUAL over EDITOR", async () => {
    const dir = await tempDir();
    const visual = await script(dir, "visual", 'echo visual > "$1"');
    const editor = await script(dir, "editor", 'echo editor > "$1"');
    const file = join(dir, "draft.md");
    const edit = editorFor({ VISUAL: visual, EDITOR: editor }, { stdoutIsTTY: false });
    expect(await edit?.(file)).toBeNull();
    expect(await readFile(file, "utf8")).toBe("visual\n");
    expect(await editorFor({ EDITOR: editor }, { stdoutIsTTY: false })?.(file)).toBeNull();
    expect(await readFile(file, "utf8")).toBe("editor\n");
  });

  it("passes a path with spaces and quotes as one argument, never interpolated", async () => {
    const dir = await tempDir();
    const out = join(dir, "args.txt");
    const editor = await script(dir, "editor", `printf '%s|%s\\n' "$#" "$1" > '${out}'`);
    const pwned = join(dir, "pwned");
    const file = join(dir, `it's a "draft" $(touch ${pwned}) \`touch ${pwned}\`.md`);
    expect(await editorFor({ EDITOR: editor }, { stdoutIsTTY: true })?.(file)).toBeNull();
    expect(await readFile(out, "utf8")).toBe(`1|${file}\n`);
    expect(existsSync(pwned)).toBe(false);
  });

  it("runs the editor string through sh, so it may carry arguments", async () => {
    const dir = await tempDir();
    const editor = await script(dir, "editor", 'printf "%s\\n" "$1" > "$2"');
    const file = join(dir, "draft.md");
    expect(await editorFor({ EDITOR: `${editor} --wait` }, { stdoutIsTTY: false })?.(file)).toBe(
      null,
    );
    expect(await readFile(file, "utf8")).toBe("--wait\n");
  });

  it("turns a non-zero exit into a note and never throws", async () => {
    const dir = await tempDir();
    const editor = await script(dir, "editor", "exit 3");
    expect(await editorFor({ EDITOR: editor }, { stdoutIsTTY: false })?.("/x")).toBe(
      "the editor exited with status 3; the draft is staged as rendered",
    );
    expect(await editorFor({ EDITOR: join(dir, "missing") }, { stdoutIsTTY: false })?.("/x")).toBe(
      "the editor exited with status 127; the draft is staged as rendered",
    );
  });
});

describe("adr new --edit with stdout piped", { timeout: 60_000 }, () => {
  const repos: TempRepo[] = [];
  afterEach(async () => {
    for (const r of repos.splice(0)) await r.dispose();
  });

  // Design review NIT 3: an editor that writes to stdout must not break the --json document.
  it("sends the editor's stdout to stderr, so stdout stays one JSON document", async () => {
    const r = await cliRepo();
    repos.push(r);
    const dir = await tempDir();
    const editor = await script(dir, "editor", 'echo "editor says hi"; echo "edited" >> "$1"');
    const sections = Object.entries(NYGARD_SECTIONS).flatMap(([k, v]) => [
      "--section",
      `${k}=${v}`,
    ]);
    const out = runAdr(r, ["new", "Use Aurora for orders", ...sections, "--edit", "--json"], {
      env: { EDITOR: editor },
    });
    expect(out.status).toBe(0);
    const doc = JSON.parse(out.stdout);
    expect(doc).toMatchObject({ format: "adr-write/v1", command: "new", ok: true });
    expect(out.stderr).toBe("editor says hi\n");
  });
});
