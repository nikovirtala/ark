import { chmod, readFile } from "node:fs/promises";
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

describe("runDoctor: a hook script that isn't executable (?77)", () => {
  const script: SetupPiece = {
    id: "hook",
    file: ".hooks/go.sh",
    ownership: { kind: "whole", text: "#!/bin/sh\n", executable: true },
  };

  it("reports it with the fix, and does not exit 1", async () => {
    const r = await repo();
    await applySetup(r.git, [script], { tool: "widget" });
    await chmod(join(r.root, ".hooks/go.sh"), 0o644);
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec([script]) });
    expect(doc.exit).toBe(0);
    expect(doc.gaps).toHaveLength(1);
    expect(doc.gaps[0]).toMatchObject({ id: "hook", kind: "not-executable" });
    expect(doc.gaps[0]?.message).toContain("chmod +x .hooks/go.sh");
    expect(doc.gaps[0]?.message).toContain("widget init --setup");
    expect(doc.pieces[0]).toMatchObject({ ok: false, kind: "not-executable" });
  });

  it("reports nothing for an executable script", async () => {
    const r = await repo();
    await applySetup(r.git, [script], { tool: "widget" });
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec([script]) });
    expect(doc.gaps).toEqual([]);
  });

  it("reports a missing script as missing, not as a mode problem", async () => {
    const r = await repo();
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec([script]) });
    expect(doc.gaps[0]).toMatchObject({ kind: "missing" });
    expect(doc.exit).toBe(1);
  });
});

describe("runDoctor: ARK_ON_BEHALF_OF per harness (?78)", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text a harness leaves
  const LITERAL = "${ARK_ON_BEHALF_OF}";
  const pieces: SetupPiece[] = [
    { ...mcp("1.0.0"), id: "claude.mcp.widget" },
    { ...mcp("1.0.0"), id: "kiro.mcp.widget", file: ".kiro/settings/mcp.json" },
  ];
  const report = async (env: NodeJS.ProcessEnv, ps: readonly SetupPiece[] = pieces) => {
    const r = await repo();
    await applySetup(r.git, ps, { tool: "widget" });
    const doc = await runDoctor(await open(r), {
      format: "widget-doctor/v1",
      ...spec(ps),
      env,
    });
    return doc;
  };

  it("says how to set an unset variable for each harness, and never changes the exit code", async () => {
    const doc = await report({});
    expect(doc.exit).toBe(0);
    expect(doc.environment.map((e) => [e.harness, e.state])).toEqual([
      ["claude", "unset"],
      ["kiro", "unset"],
    ]);
    expect(doc.environment[0]?.message).toContain("export it in the shell that starts claude");
    expect(doc.environment[1]?.message).toContain('"Mcp Approved Env Vars"');
  });

  it("treats a blank value as unset and a placeholder as unexpanded", async () => {
    expect((await report({ ARK_ON_BEHALF_OF: "  " })).environment[0]?.state).toBe("unset");
    const p = await report({ ARK_ON_BEHALF_OF: LITERAL });
    expect(p.environment.map((e) => e.state)).toEqual(["placeholder", "placeholder"]);
    expect(p.environment[0]?.message).toContain("unexpanded placeholder");
  });

  it("is quiet for Claude Code when set, and reminds Kiro to approve it", async () => {
    const doc = await report({ ARK_ON_BEHALF_OF: "niko@example.com" });
    expect(doc.environment.map((e) => [e.harness, e.state])).toEqual([
      ["claude", "ok"],
      ["kiro", "approve"],
    ]);
    expect(doc.environment[1]?.message).toContain("cannot read that setting");
  });

  it("reports only the harnesses that have an MCP piece", async () => {
    const doc = await report({}, [pieces[0] as SetupPiece]);
    expect(doc.environment.map((e) => e.harness)).toEqual(["claude"]);
  });

  it("reports nothing without an environment", async () => {
    const r = await repo();
    const doc = await runDoctor(await open(r), { format: "widget-doctor/v1", ...spec(pieces) });
    expect(doc.environment).toEqual([]);
  });
});
