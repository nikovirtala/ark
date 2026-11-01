import { installHooks } from "../hooks/install.js";
import { type PieceState, pieceStates, type SetupPiece } from "./setup.js";
import { toolHookCommands } from "./tool-hooks.js";
import type { ToolLog } from "./tool-log.js";

/**
 * Why a setup piece is a gap (design "doctor"):
 * - `missing`: the piece is not there at all (the only kind that makes doctor exit 1, R5).
 * - `outdated`: the piece is there and is what init last wrote, but an older version of the tool
 *   wrote it, so it differs from what the installed tool would write now.
 * - `changed`: the piece is there but someone edited it, so it differs from both what init last
 *   wrote and what the installed tool would write.
 * - `wrong-version`: the MCP config points at a version other than the one installed.
 */
export type GapKind = "missing" | "outdated" | "changed" | "wrong-version";

/** One piece that is not what the installed tool would write, with the command that fixes it. */
export interface Gap {
  readonly id: string;
  readonly file: string;
  readonly kind: GapKind;
  /** One line: what is wrong and the command that fixes it. */
  readonly message: string;
}

/** `<tool> doctor --json` (design "doctor"). */
export interface DoctorResult {
  readonly format: string;
  /** Every piece checked, in table order, whether a gap or not. */
  readonly pieces: readonly {
    readonly id: string;
    readonly file: string;
    readonly ok: boolean;
    readonly kind: GapKind | null;
  }[];
  readonly gaps: readonly Gap[];
  /** 1 when any piece is missing (R5), else 0. */
  readonly exit: 0 | 1;
  /** With `--fix-clone`: the git-hook shims written (none when they were already installed). */
  readonly fixedClone: readonly string[];
  readonly notes: readonly string[];
}

/** What a tool passes to {@link runDoctor}: its name, JSON format, pieces and the installed version. */
export interface DoctorSpec {
  /** The tool's name: the fixing commands read `<tool> init …`, hook install `<tool> hooks install`. */
  readonly tool: string;
  /** The `--json` document's `format`, e.g. `adr-doctor/v1`. */
  readonly format: string;
  /** The setup pieces to check — the same pieces init would write (reused from the setup engine). */
  readonly pieces: readonly SetupPiece[];
  /** The exact version the installed tool pins, for the wrong-version message. */
  readonly installedVersion: string;
}

/** The fixing command a gap names, after `<tool>`. */
function fix(tool: string, id: string, kind: GapKind): string {
  // A changed piece is only overwritten with --force; the rest are a plain rerun of init --setup.
  return kind === "changed" ? `${tool} init --setup --force ${id}` : `${tool} init --setup`;
}

/** The gap for a piece state, or `null` when the piece is what the installed tool would write. */
function gapFor(tool: string, s: PieceState): Gap | null {
  if (!s.present) {
    return {
      id: s.id,
      file: s.file,
      kind: "missing",
      message: `${s.file}: ${s.id} is missing; run ${fix(tool, s.id, "missing")} to write it`,
    };
  }
  if (s.matchesTarget) return null;
  if (s.changed) {
    return {
      id: s.id,
      file: s.file,
      kind: "changed",
      message: `${s.file}: ${s.id} was changed since init wrote it; run ${fix(tool, s.id, "changed")} to overwrite it`,
    };
  }
  // Not changed by anyone, but differs from the target: init wrote it with an older tool. When the
  // difference is a pinned version, say which versions, so the gap is actionable.
  if (s.version !== null && s.targetVersion !== null && s.version !== s.targetVersion) {
    return {
      id: s.id,
      file: s.file,
      kind: "wrong-version",
      message: `${s.file}: ${s.id} pins ${s.version}, not the installed ${s.targetVersion}; run ${fix(tool, s.id, "wrong-version")} to update it`,
    };
  }
  return {
    id: s.id,
    file: s.file,
    kind: "outdated",
    message: `${s.file}: ${s.id} is out of date (written by an older ${tool}); run ${fix(tool, s.id, "outdated")} to update it`,
  };
}

export interface RunDoctorOptions {
  /** Install the per-clone git hooks; never wrong to install, so doctor always offers it. */
  readonly fixClone?: boolean;
}

/**
 * `doctor`: checks every setup piece against what the installed tool would write and reports each
 * gap with the command that fixes it (design "doctor", R5). It never writes a committed file. It
 * exits 1 when any piece is missing, else 0; an outdated, changed or wrong-version piece is a gap
 * but does not change the exit code. With `--fix-clone` it also installs the per-clone git hooks
 * (what can never be wrong to install), reusing the shared hook-install steps, and reports which
 * shims it wrote; it says why it could not when another tool owns the hooks path.
 */
export async function runDoctor(
  log: ToolLog,
  spec: DoctorSpec,
  o: RunDoctorOptions = {},
): Promise<DoctorResult> {
  const states = await pieceStates(log.git, spec.pieces);
  const gaps: Gap[] = [];
  const pieces = states.map((s) => {
    const gap = gapFor(spec.tool, s);
    if (gap !== null) gaps.push(gap);
    return { id: s.id, file: s.file, ok: gap === null, kind: gap?.kind ?? null };
  });
  const missing = gaps.some((g) => g.kind === "missing");

  const notes: string[] = [];
  const fixedClone: string[] = [];
  if (o.fixClone === true) {
    await fixClone(log, spec.tool, fixedClone, notes);
  }

  return {
    format: spec.format,
    pieces,
    gaps,
    exit: missing ? 1 : 0,
    fixedClone,
    notes,
  };
}

/** Installs this clone's git hooks (R6), or notes why it cannot. Never touches committed files. */
async function fixClone(
  log: ToolLog,
  tool: string,
  fixedClone: string[],
  notes: string[],
): Promise<void> {
  const r = await installHooks(log.git, { tool, commands: toolHookCommands(log, tool) });
  for (const path of r.written) fixedClone.push(path);
  for (const c of r.conflicts) {
    if (c.reason === "hooks-path") {
      notes.push(
        `could not install git hooks: core.hooksPath is set, so another tool manages them; run ${tool} hooks print to add them`,
      );
    } else {
      notes.push(
        `could not install the ${c.hook} git hook: ${c.path} exists and is not an ark hook; move it away and run ${tool} hooks install`,
      );
    }
  }
}
