import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type JsonValue, UsageError } from "@nikovirtala/ledger";
import { COMMIT_OPTIONS, type CommandSpec, commitChoice } from "@nikovirtala/ledger/cli";
import { initIssueLog } from "../init.js";
import { openForCli, strings } from "./open.js";
import { initText } from "./text.js";

const DEFAULT_SKILL_DIR = ".claude/skills/issues";
const MAX_DIR = 1024;

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
      template: { type: "string", multiple: true },
      skill: { type: "boolean" },
      "skill-dir": { type: "string" },
      ...COMMIT_OPTIONS,
    },
    positionals: { min: 0, max: 0, names: [] },
    ref: "reject",
    async run({ io, flags, values }) {
      const given = typeof values["skill-dir"] === "string" ? values["skill-dir"] : null;
      if (given !== null && values.skill !== true) {
        throw new UsageError("--skill-dir needs --skill");
      }
      const log = await openForCli(io, flags);
      const root = log.git.root ?? io.cwd;
      const dir =
        values.skill !== true
          ? null
          : given === null
            ? DEFAULT_SKILL_DIR
            : await skillDir(root, io.cwd, given);
      const doc = await initIssueLog(log, {
        templates: strings(values.template),
        ...(dir === null ? {} : { skill: { dir, version } }),
        ...commitChoice(values, { autoCommit: log.issues.autoCommit }),
      });
      return { exit: 0, json: doc as unknown as JsonValue, text: initText(doc), notes: doc.notes };
    },
  };
}
