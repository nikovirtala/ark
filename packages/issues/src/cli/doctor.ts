import { ARK_PINS, arkSetup, detectHarnesses, setupPieces } from "@nikovirtala/ledger";
import { type CommandSpec, doctorCommand } from "@nikovirtala/ledger/cli";
import { openForCli } from "./open.js";

/**
 * `issues doctor [--fix-clone]` (design "doctor", ?60): reports what is missing or out of date in
 * the repository's agent setup against what the installed issues would write, with the command
 * that fixes each gap, and exits 1 when any piece is missing (R5). `--fix-clone` also installs
 * this clone's git hooks (R6). It checks the same pieces `issues init --setup` writes.
 */
export function issuesDoctorCommand(): CommandSpec {
  return doctorCommand({
    tool: "issues",
    format: "issues-doctor/v1",
    async open({ io, flags }) {
      const log = await openForCli(io, flags);
      const harnesses = await detectHarnesses(log.git);
      const setup = arkSetup({
        harnesses,
        pkg: "@nikovirtala/issues",
        name: "issues",
        version: ARK_PINS.issues,
        pins: ARK_PINS,
      });
      return { log, spec: { pieces: setupPieces(setup), installedVersion: ARK_PINS.issues } };
    },
  });
}
