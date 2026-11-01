import { ARK_PINS, arkSetup, detectHarnesses, setupPieces } from "@nikovirtala/ledger";
import { type CommandSpec, doctorCommand } from "@nikovirtala/ledger/cli";
import { openForCli } from "./open.js";

/**
 * `adr doctor [--fix-clone]` (design "doctor", ?60): reports what is missing or out of date in the
 * repository's agent setup against what the installed adr would write, with the command that fixes
 * each gap, and exits 1 when any piece is missing (R5). `--fix-clone` also installs this clone's
 * git hooks (R6). It checks the same pieces `adr init --setup` writes, built from `arkSetup`.
 */
export function adrDoctorCommand(): CommandSpec {
  return doctorCommand({
    tool: "adr",
    format: "adr-doctor/v1",
    async open({ io, flags }) {
      const log = await openForCli(io, flags);
      const harnesses = await detectHarnesses(log.git);
      const setup = arkSetup({
        harnesses,
        pkg: "@nikovirtala/adr",
        name: "adr",
        version: ARK_PINS.adr,
        pins: ARK_PINS,
      });
      return { log, spec: { pieces: setupPieces(setup), installedVersion: ARK_PINS.adr } };
    },
  });
}
