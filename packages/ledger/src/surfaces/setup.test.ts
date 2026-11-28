import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { applySetup, pieceStates, SETUP_LOCK, type SetupPiece } from "./setup.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = {}): Promise<TempRepo> {
  const r = await createTempRepo({ files: { "README.md": "x\n", ...files } });
  repos.push(r);
  return r;
}
const read = (r: TempRepo, path: string) => readFile(join(r.root, path), "utf8");
const exists = (r: TempRepo, path: string) =>
  readFile(join(r.root, path)).then(
    () => true,
    () => false,
  );

const whole = (id: string, file: string, text: string): SetupPiece => ({
  id,
  file,
  ownership: { kind: "whole", text },
});
const server = (id: string, name: string, value: unknown): SetupPiece => ({
  id,
  file: "config.json",
  ownership: {
    kind: "merge",
    scaffold: { mcpServers: {} },
    entries: { [`mcpServers.${name}`]: value },
  },
});

describe("applySetup: whole-file pieces", () => {
  it("writes a missing piece, records the committed and per-clone lock, and rewrites nothing on a no-op rerun", async () => {
    const r = await repo();
    const piece = whole("hook", ".hooks/go.sh", "#!/bin/sh\necho hi\n");
    const first = await applySetup(r.git, [piece], { tool: "widget" });
    expect(first.outcomes).toEqual([{ id: "hook", file: ".hooks/go.sh", status: "wrote" }]);
    expect(first.written).toContain(".hooks/go.sh");
    expect(first.written).toContain(SETUP_LOCK);
    expect(await read(r, ".hooks/go.sh")).toBe("#!/bin/sh\necho hi\n");
    // The per-clone lock mirrors the committed one.
    expect(await readFile(join(r.git.commonDir, "ark", "setup.json"), "utf8")).toBe(
      await read(r, SETUP_LOCK),
    );

    const lockBefore = await read(r, SETUP_LOCK);
    const again = await applySetup(r.git, [piece], { tool: "widget" });
    expect(again.outcomes).toEqual([{ id: "hook", file: ".hooks/go.sh", status: "kept" }]);
    expect(again.written).toEqual([]);
    expect(await read(r, SETUP_LOCK)).toBe(lockBefore);
  });

  it("updates a piece that still matches the last-written hash", async () => {
    const r = await repo();
    const v1 = whole("hook", ".hooks/go.sh", "one\n");
    await applySetup(r.git, [v1], { tool: "widget" });
    const v2 = whole("hook", ".hooks/go.sh", "two\n");
    const doc = await applySetup(r.git, [v2], { tool: "widget" });
    expect(doc.outcomes[0]?.status).toBe("wrote");
    expect(await read(r, ".hooks/go.sh")).toBe("two\n");
  });

  it("leaves a piece someone changed alone with a note naming the file and --force", async () => {
    const r = await repo();
    const piece = whole("hook", ".hooks/go.sh", "owned\n");
    await applySetup(r.git, [piece], { tool: "widget" });
    await r.write(".hooks/go.sh", "edited by a person\n");
    const next = whole("hook", ".hooks/go.sh", "new owned\n");
    const doc = await applySetup(r.git, [next], { tool: "widget" });
    expect(doc.outcomes[0]?.status).toBe("changed");
    expect(doc.written).toEqual([]);
    expect(doc.notes).toEqual([
      ".hooks/go.sh was changed since init wrote it, so it is left as it is; run widget init --force hook to overwrite it",
    ]);
    expect(await read(r, ".hooks/go.sh")).toBe("edited by a person\n");
  });

  it("overwrites a changed piece with --force", async () => {
    const r = await repo();
    const piece = whole("hook", ".hooks/go.sh", "owned\n");
    await applySetup(r.git, [piece], { tool: "widget" });
    await r.write(".hooks/go.sh", "edited\n");
    const next = whole("hook", ".hooks/go.sh", "forced\n");
    const doc = await applySetup(r.git, [next], { tool: "widget", force: new Set(["hook"]) });
    expect(doc.outcomes[0]?.status).toBe("wrote");
    expect(await read(r, ".hooks/go.sh")).toBe("forced\n");
  });

  it("skips a piece by id", async () => {
    const r = await repo();
    const doc = await applySetup(r.git, [whole("hook", ".hooks/go.sh", "x\n")], {
      tool: "widget",
      skip: new Set(["hook"]),
    });
    expect(doc.outcomes).toEqual([]);
    expect(await exists(r, ".hooks/go.sh")).toBe(false);
  });
});

describe("applySetup: merge pieces", () => {
  it("adds its own entry and leaves another server in the file alone", async () => {
    const r = await repo({
      "config.json": `{\n  "mcpServers": {\n    "mine": { "command": "x" }\n  }\n}\n`,
    });
    const doc = await applySetup(r.git, [server("srv.adr", "adr", { command: "adr" })], {
      tool: "widget",
    });
    expect(doc.outcomes[0]?.status).toBe("wrote");
    const parsed = JSON.parse(await read(r, "config.json")) as {
      mcpServers: Record<string, unknown>;
    };
    // Both the pre-existing server and the owned one are present.
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["adr", "mine"]);
    expect(parsed.mcpServers.mine).toEqual({ command: "x" });
  });

  it("two tools share one file, each owning its own server, and a rerun is a no-op", async () => {
    const r = await repo();
    await applySetup(r.git, [server("srv.adr", "adr", { command: "adr" })], { tool: "adr" });
    await applySetup(r.git, [server("srv.issues", "issues", { command: "issues" })], {
      tool: "issues",
    });
    const parsed = JSON.parse(await read(r, "config.json")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["adr", "issues"]);
    // Each tool's rerun changes nothing.
    const before = await read(r, "config.json");
    const rerun = await applySetup(r.git, [server("srv.adr", "adr", { command: "adr" })], {
      tool: "adr",
    });
    expect(rerun.outcomes[0]?.status).toBe("kept");
    expect(await read(r, "config.json")).toBe(before);
  });

  it("treats only its own entry's change as 'changed', not another server's edit", async () => {
    const r = await repo();
    await applySetup(r.git, [server("srv.adr", "adr", { command: "adr" })], { tool: "adr" });
    // A person adds their own server to the same file.
    const parsed = JSON.parse(await read(r, "config.json")) as {
      mcpServers: Record<string, unknown>;
    };
    parsed.mcpServers.mine = { command: "x" };
    await r.write("config.json", `${JSON.stringify(parsed, null, 2)}\n`);
    // adr's rerun still owns its entry (unchanged) and leaves the person's server in place.
    const doc = await applySetup(r.git, [server("srv.adr", "adr", { command: "adr" })], {
      tool: "adr",
    });
    expect(doc.outcomes[0]?.status).toBe("kept");
    const after = JSON.parse(await read(r, "config.json")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(after.mcpServers).sort()).toEqual(["adr", "mine"]);
  });
});

describe("applySetup: executable pieces (?77)", () => {
  const script = (text = "#!/bin/sh\necho hi\n"): SetupPiece => ({
    id: "hook",
    file: ".hooks/go.sh",
    ownership: { kind: "whole", text, executable: true },
  });
  const mode = async (r: TempRepo, path: string) => (await stat(join(r.root, path))).mode & 0o777;

  it("writes an executable piece as 755 and a plain one as the umask makes it", async () => {
    const r = await repo();
    const doc = await applySetup(r.git, [script(), whole("plain", ".hooks/readme.txt", "x\n")], {
      tool: "widget",
    });
    expect(await mode(r, ".hooks/go.sh")).toBe(0o755);
    expect((await mode(r, ".hooks/readme.txt")) & 0o111).toBe(0);
    expect(doc.executable).toEqual([".hooks/go.sh"]);
  });

  it("restores the bit on a rerun when the bytes are right and the mode isn't, and touches nothing else", async () => {
    const r = await repo();
    await applySetup(r.git, [script()], { tool: "widget" });
    const lock = await read(r, SETUP_LOCK);
    await chmod(join(r.root, ".hooks/go.sh"), 0o644);
    const doc = await applySetup(r.git, [script()], { tool: "widget" });
    expect(doc.outcomes).toEqual([{ id: "hook", file: ".hooks/go.sh", status: "wrote" }]);
    expect(doc.written).toEqual([".hooks/go.sh"]);
    expect(doc.executable).toEqual([".hooks/go.sh"]);
    expect(await mode(r, ".hooks/go.sh")).toBe(0o755);
    expect(await read(r, SETUP_LOCK)).toBe(lock);
    // And a second rerun has nothing to do.
    const again = await applySetup(r.git, [script()], { tool: "widget" });
    expect(again.outcomes[0]?.status).toBe("kept");
    expect(again.written).toEqual([]);
    expect(again.executable).toEqual([]);
  });

  it("keeps the bit when it updates the bytes of an unchanged piece", async () => {
    const r = await repo();
    await applySetup(r.git, [script("one\n")], { tool: "widget" });
    const doc = await applySetup(r.git, [script("two\n")], { tool: "widget" });
    expect(doc.outcomes[0]?.status).toBe("wrote");
    expect(await mode(r, ".hooks/go.sh")).toBe(0o755);
  });

  it("leaves a changed piece alone, mode included", async () => {
    const r = await repo();
    await applySetup(r.git, [script("one\n")], { tool: "widget" });
    await r.write(".hooks/go.sh", "edited\n");
    await chmod(join(r.root, ".hooks/go.sh"), 0o644);
    const doc = await applySetup(r.git, [script("two\n")], { tool: "widget" });
    expect(doc.outcomes[0]?.status).toBe("changed");
    expect(await mode(r, ".hooks/go.sh")).toBe(0o644);
  });

  it("reports the mode in pieceStates", async () => {
    const r = await repo();
    await applySetup(r.git, [script()], { tool: "widget" });
    const [ok] = await pieceStates(r.git, [script()]);
    expect(ok).toMatchObject({ present: true, needsExecutable: true, executable: true });
    await chmod(join(r.root, ".hooks/go.sh"), 0o644);
    const [lost] = await pieceStates(r.git, [script()]);
    expect(lost).toMatchObject({ matchesTarget: true, needsExecutable: true, executable: false });
    const [plain] = await pieceStates(r.git, [whole("p", ".hooks/go.sh", "#!/bin/sh\necho hi\n")]);
    expect(plain?.needsExecutable).toBe(false);
  });

  it("stages 100755 in the index when the file system can't keep the bit", async () => {
    const r = await repo();
    await r.git.run(["config", "core.fileMode", "false"]);
    const doc = await applySetup(r.git, [script()], { tool: "widget" });
    await r.git.add(doc.written);
    await r.git.run(["update-index", "--chmod=+x", "--", ...doc.executable]);
    const staged = Buffer.from(
      (await r.git.run(["ls-files", "-s", ".hooks/go.sh"])).stdout,
    ).toString("utf8");
    expect(staged).toMatch(/^100755 /);
  });
});

describe("applySetup: lines pieces", () => {
  const attrs = (id: string, ...lines: string[]): SetupPiece => ({
    id,
    file: ".gitattributes",
    ownership: { kind: "lines", lines },
  });
  const adr = attrs("gitattributes.adr", "docs/adr/events/** linguist-generated=true");
  const issues = attrs("gitattributes.issues", "docs/issues/events/** linguist-generated=true");

  it("creates the file with its lines, and two pieces sharing it compose", async () => {
    const r = await repo();
    const doc = await applySetup(r.git, [adr, issues], { tool: "widget" });
    expect(doc.outcomes.map((o) => o.status)).toEqual(["wrote", "wrote"]);
    expect(await read(r, ".gitattributes")).toBe(
      "docs/adr/events/** linguist-generated=true\ndocs/issues/events/** linguist-generated=true\n",
    );
    const again = await applySetup(r.git, [adr, issues], { tool: "widget" });
    expect(again.outcomes.map((o) => o.status)).toEqual(["kept", "kept"]);
    expect(again.written).toEqual([]);
  });

  it("appends to a file it doesn't own and leaves every other line alone", async () => {
    const r = await repo({ ".gitattributes": "*.png binary\n# vendored\nvendor/** -diff" });
    await applySetup(r.git, [adr], { tool: "widget" });
    expect(await read(r, ".gitattributes")).toBe(
      "*.png binary\n# vendored\nvendor/** -diff\ndocs/adr/events/** linguist-generated=true\n",
    );
  });

  it("updates its line where it stands when it still matches what init wrote", async () => {
    const r = await repo();
    await applySetup(r.git, [adr], { tool: "widget" });
    await r.write(".gitattributes", `${await read(r, ".gitattributes")}*.png binary\n`);
    const next = attrs("gitattributes.adr", "docs/adr/events/** linguist-generated=true -diff");
    const doc = await applySetup(r.git, [next], { tool: "widget" });
    expect(doc.outcomes[0]?.status).toBe("wrote");
    expect(await read(r, ".gitattributes")).toBe(
      "docs/adr/events/** linguist-generated=true -diff\n*.png binary\n",
    );
  });

  it("leaves a line someone changed alone with the --force note, and --force replaces it", async () => {
    const r = await repo({ ".gitattributes": "docs/adr/events/** -linguist-generated\n" });
    await applySetup(r.git, [], { tool: "widget" });
    const doc = await applySetup(r.git, [adr], { tool: "widget" });
    expect(doc.outcomes[0]?.status).toBe("changed");
    expect(doc.notes).toEqual([
      ".gitattributes was changed since init wrote it, so it is left as it is; run widget init --force gitattributes.adr to overwrite it",
    ]);
    expect(await read(r, ".gitattributes")).toBe("docs/adr/events/** -linguist-generated\n");
    const [state] = await pieceStates(r.git, [adr]);
    expect(state).toMatchObject({ present: true, matchesTarget: false, changed: true });

    await applySetup(r.git, [adr], { tool: "widget", force: new Set(["gitattributes.adr"]) });
    expect(await read(r, ".gitattributes")).toBe("docs/adr/events/** linguist-generated=true\n");
  });

  it("reports a missing line in pieceStates", async () => {
    const r = await repo({ ".gitattributes": "*.png binary\n" });
    const [state] = await pieceStates(r.git, [adr]);
    expect(state).toMatchObject({ present: false, matchesTarget: false, changed: false });
    await applySetup(r.git, [adr], { tool: "widget" });
    const [after] = await pieceStates(r.git, [adr]);
    expect(after).toMatchObject({ present: true, matchesTarget: true, changed: false });
  });
});
