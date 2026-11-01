import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exampleMachineKind as kind } from "../testing/example-machine-kind.js";
import { createTempRepo, type TempRepo } from "../testing/temp-repo.js";
import { type DoctorSpec, runDoctor } from "./doctor.js";
import { applySetup, type SetupPiece } from "./setup.js";
import { openToolLog } from "./tool-log.js";

const repos: TempRepo[] = [];
afterEach(async () => {
  for (const r of repos.splice(0)) await r.dispose();
});
async function repo(files: Record<string, string> = { "README.md": "x\n" }): Promise<TempRepo> {
  const r = await createTempRepo({ files });
  repos.push(r);
  return r;
}
const open = (r: TempRepo) =>
  openToolLog({ cwd: r.root, tool: "widget", kind, root: null, gitOptions: { env: r.env } });

const whole = (id: string, file: string, text: string): SetupPiece => ({
  id,
  file,
  ownership: { kind: "whole", text },
});
const mcp = (version: string): SetupPiece => ({
  id: "claude.mcp.widget",
  file: ".mcp.json",
  ownership: {
    kind: "merge",
    scaffold: { mcpServers: {} },
    entries: {
      "mcpServers.widget": { command: "npx", args: ["-y", `widget@${version}`, "mcp"] },
    },
  },
});

/** The {@link DoctorSpec} tail for `widget` at `version`, checking `pieces`. */
const spec = (pieces: readonly SetupPiece[], version = "1.0.0"): Omit<DoctorSpec, "format"> => ({
  tool: "widget",
  pieces,
  installedVersion: version,
});

describe("runDoctor: gap kinds and the exit-1-on-missing contract (R5)", () => {
  it("reports no gaps and exits 0 when every piece is what the installed tool would write", async () => {
    const r = await repo();
    const pieces = [whole("hook", ".hooks/go.sh", "owned\n"), mcp("1.0.0")];
    await applySetup(r.git, pieces, { tool: "widget" });
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec(pieces) });
    expect(doc.gaps).toEqual([]);
    expect(doc.exit).toBe(0);
    expect(doc.pieces.every((p) => p.ok)).toBe(true);
  });

  it("reports a missing piece and exits 1", async () => {
    const r = await repo();
    const pieces = [whole("hook", ".hooks/go.sh", "owned\n")];
    // Nothing applied: the piece is missing.
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec(pieces) });
    expect(doc.exit).toBe(1);
    expect(doc.gaps).toHaveLength(1);
    expect(doc.gaps[0]).toMatchObject({ id: "hook", kind: "missing" });
    expect(doc.gaps[0]?.message).toContain("is missing");
    expect(doc.gaps[0]?.message).toContain("widget init --setup");
  });

  it("reports a piece someone changed as 'changed', naming --force, and does not exit 1", async () => {
    const r = await repo();
    const pieces = [whole("hook", ".hooks/go.sh", "owned\n")];
    await applySetup(r.git, pieces, { tool: "widget" });
    await r.write(".hooks/go.sh", "edited by a person\n");
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec(pieces) });
    expect(doc.exit).toBe(0);
    expect(doc.gaps[0]).toMatchObject({ id: "hook", kind: "changed" });
    expect(doc.gaps[0]?.message).toContain("widget init --setup --force hook");
  });

  it("reports an out-of-date piece (written by an older tool) and does not exit 1", async () => {
    const r = await repo();
    // init wrote v1; the installed tool now writes v2, and nobody touched the file.
    await applySetup(r.git, [whole("hook", ".hooks/go.sh", "v1\n")], { tool: "widget" });
    const doc = await runDoctor(await open(r), {
      format: "widget-doctor/v1",
      ...spec([whole("hook", ".hooks/go.sh", "v2\n")]),
    });
    expect(doc.exit).toBe(0);
    expect(doc.gaps[0]).toMatchObject({ id: "hook", kind: "outdated" });
    expect(doc.gaps[0]?.message).toContain("out of date");
    expect(doc.gaps[0]?.message).toContain("widget init --setup");
  });

  it("reports an MCP pin naming a version other than the installed one as 'wrong-version'", async () => {
    const r = await repo();
    // init wrote the 0.9.0 pin; the installed tool pins 1.0.0, and nobody touched the file.
    await applySetup(r.git, [mcp("0.9.0")], { tool: "widget" });
    const doc = await runDoctor(await open(r), {
      format: "widget-doctor/v1",
      ...spec([mcp("1.0.0")]),
    });
    expect(doc.exit).toBe(0);
    expect(doc.gaps[0]).toMatchObject({ id: "claude.mcp.widget", kind: "wrong-version" });
    expect(doc.gaps[0]?.message).toContain("0.9.0");
    expect(doc.gaps[0]?.message).toContain("1.0.0");
  });

  it("exits 1 when any piece is missing even alongside non-missing gaps", async () => {
    const r = await repo();
    await applySetup(r.git, [whole("hook", ".hooks/go.sh", "v1\n")], { tool: "widget" });
    const doc = await runDoctor(await open(r), {
      format: "widget-doctor/v1",
      ...spec([
        whole("hook", ".hooks/go.sh", "v2\n"), // outdated
        whole("other", ".hooks/other.sh", "x\n"), // missing
      ]),
    });
    expect(doc.exit).toBe(1);
    expect(doc.gaps.map((g) => g.kind).sort()).toEqual(["missing", "outdated"]);
  });
});

describe("runDoctor: --fix-clone installs the git hooks (R6)", () => {
  it("installs this clone's git hooks and lists the shims", async () => {
    const r = await repo();
    const doc = await runDoctor(
      await open(r),
      { format: "widget-doctor/v1", ...spec([]) },
      { fixClone: true },
    );
    expect(doc.fixedClone.length).toBe(4);
    const shim = await readFile(join(r.git.gitDir, "hooks/pre-commit"), "utf8");
    expect(shim).toContain("widget");
    // A second run is idempotent: the hooks are already installed.
    const again = await runDoctor(
      await open(r),
      { format: "widget-doctor/v1", ...spec([]) },
      { fixClone: true },
    );
    expect(again.fixedClone).toEqual([]);
  });

  it("does not install the hooks without --fix-clone", async () => {
    const r = await repo();
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec([]) });
    expect(doc.fixedClone).toEqual([]);
    await expect(readFile(join(r.git.gitDir, "hooks/pre-commit"), "utf8")).rejects.toThrow();
  });
});
