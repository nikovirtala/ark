import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ARK_PINS,
  arkSetup,
  detectHarnesses,
  HARNESSES,
  type Harness,
  type JsonValue,
  UsageError,
} from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { initIssueLog } from "../init.js";
import { openForCli, strings } from "./open.js";
import { initText } from "./text.js";

const DEFAULT_SKILL_DIR = ".claude/skills/issues";
const MAX_DIR = 1024;

/** The skill directories `--setup` writes: one per harness, under its skills folder. */
const SKILL_DIRS: Readonly<Record<Harness, string>> = {
  claude: ".claude/skills/issues",
  kiro: ".kiro/skills/issues",
};

/** Validates `--harness <name>` opt-out values and returns the harnesses to keep. */
function keepHarnesses(detected: readonly Harness[], optedOut: readonly string[]): Harness[] {
  for (const h of optedOut) {
    if (!HARNESSES.includes(h as Harness)) {
      throw new UsageError(`--harness must be one of ${HARNESSES.join(", ")}`);
    }
  }
  return detected.filter((h) => !optedOut.includes(h));
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** `--skill-dir` as a repo-relative directory inside the work tree and outside `.git`. */
async function skillDir(root: string, cwd: string, given: string): Promise<string> {
  const dir = given.trim();
  const bad = () => new UsageError("--skill-dir must be a directory inside the repository");
  if (dir === "" || dir.length > MAX_DIR || dir.includes("\0")) throw bad();
  const base = await realpath(cwd).catch(() => cwd);
  const rel = relative(root, resolve(base, dir));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw bad();
  const segments = rel.split(sep).filter((s) => s !== "");
  if (segments[0] === ".git") throw bad();
  return segments.join("/");
}

/**
 * `issues init [--template <name>]… [--skill [--skill-dir <path>]] [--commit | --no-commit]
 * [-m <message>]` (design §8.2).
 */
export function initCommand(version: string): CommandSpec {
  return {
    name: "init",
    summary: "set up an issue log: a config file and starter templates",
    usage:
      "init [--template bug|feature|task]… [--skill [--skill-dir <path>]] [--commit | --no-commit] [-m <message>]",
    options: {
      template: {
        type: "string",
        multiple: true,
        value: "<name>",
        help: "write the built-in template bug, feature or task (default: task)",
      },
      skill: {
        type: "boolean",
        help: "also write the agent skill (SKILL.md) and its AGENTS.md pointer",
      },
      "skill-dir": {
        type: "string",
        value: "<path>",
        help: "the directory --skill writes to (default: .claude/skills/issues)",
      },
      setup: {
        type: "boolean",
        help: "also write the agent setup: MCP config, harness hooks, permissions and a prepare script",
      },
      mcp: {
        type: "boolean",
        help: "with --setup, write the MCP config (default: on)",
        negatedHelp: "with --setup, skip the MCP config",
      },
      hooks: {
        type: "boolean",
        help: "with --setup, write the harness hooks and prepare script (default: on)",
        negatedHelp: "with --setup, skip the harness hooks and prepare",
      },
      harness: {
        type: "string",
        multiple: true,
        value: "<name>",
        help: "with --setup, skip a harness: claude or kiro",
      },
      force: {
        type: "string",
        multiple: true,
        value: "<piece>",
        help: "with --setup, overwrite a piece someone changed, by its id",
      },
      ...COMMIT_OPTIONS,
    },
    positionals: { min: 0, max: 0, names: [] },
    ref: "reject",
    async run({ io, flags, values }) {
      const given = typeof values["skill-dir"] === "string" ? values["skill-dir"] : null;
      if (given !== null && values.skill !== true) {
        throw new UsageError("--skill-dir needs --skill");
      }
      const wantSetup = values.setup === true;
      if (!wantSetup) {
        for (const f of ["mcp", "hooks", "harness", "force"]) {
          const v = values[f];
          if (v === false || (Array.isArray(v) && v.length > 0)) {
            throw new UsageError(`--${f === "mcp" || f === "hooks" ? `no-${f}` : f} needs --setup`);
          }
        }
      }
      const log = await openForCli(io, flags);
      const root = log.git.root ?? io.cwd;
      const harnesses = wantSetup
        ? keepHarnesses(await detectHarnesses(log.git), strs(values.harness))
        : [];
      const skill =
        values.skill === true || wantSetup
          ? wantSetup
            ? { dirs: harnesses.map((h) => SKILL_DIRS[h]), version }
            : {
                dir: given === null ? DEFAULT_SKILL_DIR : await skillDir(root, io.cwd, given),
                version,
              }
          : null;
      const skip = new Set<string>();
      if (values.mcp === false) skip.add("mcp");
      if (values.hooks === false) skip.add("hooks");
      const setup = wantSetup
        ? arkSetup({
            harnesses,
            pkg: "@nikovirtala/issues",
            name: "issues",
            version: ARK_PINS.issues,
            pins: ARK_PINS,
            skip,
            force: new Set(strs(values.force)),
          })
        : null;
      const doc = await initIssueLog(log, {
        templates: strings(values.template),
        ...(skill === null ? {} : { skill }),
        ...(setup === null ? {} : { setup }),
        ...commitChoice(values, { autoCommit: log.issues.autoCommit }),
      });
      return { exit: 0, json: doc as unknown as JsonValue, text: initText(doc), notes: doc.notes };
    },
  };
}
