import type { JsonValue } from "../errors.js";
import { type DoctorResult, type DoctorSpec, runDoctor } from "../surfaces/doctor.js";
import type { ToolLog } from "../surfaces/tool-log.js";
import type { GlobalFlags } from "./flags.js";
import type { CliIO } from "./output.js";
import type { CommandSpec } from "./run.js";

export interface DoctorCommandOptions<L extends ToolLog> {
  /** The tool's name, for the summary and usage. */
  readonly tool: string;
  /** The `--json` document's `format`, e.g. `adr-doctor/v1`. */
  readonly format: string;
  /** Opens the tool's log (work tree) and supplies the pieces and the installed version to check. */
  open(ctx: {
    readonly io: CliIO;
    readonly flags: GlobalFlags;
  }): Promise<{ readonly log: L; readonly spec: Omit<DoctorSpec, "tool" | "format"> }>;
}

/** The text a doctor run prints: one line per gap, or a line saying the setup is complete. */
function doctorText(tool: string, r: DoctorResult): string {
  const lines: string[] = [];
  if (r.gaps.length === 0) {
    lines.push(`${tool}: agent setup is complete`);
  } else {
    lines.push(`${tool}: ${r.gaps.length} agent-setup gap${r.gaps.length === 1 ? "" : "s"}:`);
    for (const gap of r.gaps) lines.push(`  ${gap.message}`);
  }
  for (const path of r.fixedClone) lines.push(`installed git hook ${path}`);
  return lines.join("\n");
}

/**
 * The shared `doctor [--fix-clone]` command (design "doctor", R5/R6): checks every setup piece
 * against what the installed tool would write and reports each gap with the fixing command,
 * exiting 1 when any piece is missing. `--fix-clone` also installs this clone's git hooks, which
 * can never be wrong to install, and says why it could not.
 */
export function doctorCommand<L extends ToolLog>(o: DoctorCommandOptions<L>): CommandSpec {
  const { tool } = o;
  return {
    name: "doctor",
    summary: "report what is missing or out of date in the agent setup",
    usage: "doctor [--fix-clone]",
    options: {
      "fix-clone": {
        type: "boolean",
        help: "also install this clone's git hooks if they are missing",
      },
    },
    positionals: { min: 0, max: 0, names: [] },
    ref: "reject",
    async run({ io, flags, values }) {
      const { log, spec } = await o.open({ io, flags });
      const r = await runDoctor(
        log,
        { tool, format: o.format, ...spec },
        { fixClone: values["fix-clone"] === true },
      );
      return {
        exit: r.exit,
        json: r as unknown as JsonValue,
        text: doctorText(tool, r),
        notes: [...log.notes, ...r.notes],
      };
    },
  };
}
