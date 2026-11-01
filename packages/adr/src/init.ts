import { initToolLog, type ToolSetup } from "@nikovirtala/ledger";
import type { DecisionLog } from "./log.js";
import { INDEX_AFTER, renderDecisionIndex } from "./log-index.js";
import { SKILL_MD } from "./skill.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

export { namesSkill } from "@nikovirtala/ledger";

/** `adr init --json` (design §6.2). */
export interface InitResultJson {
  readonly format: "adr-init/v1";
  readonly root: string;
  /** The config file of the log after init, repo-relative; `null` if there is none. */
  readonly config: string | null;
  /** Repo-relative paths written, in write order. */
  readonly written: readonly string[];
  /** Files that were already there and were left as they are. */
  readonly kept: readonly string[];
  /** With `--skill`, the SKILL.md path (written or kept); else `null`. */
  readonly skill: string | null;
  readonly commit: string | null;
  readonly notes: readonly string[];
}

/**
 * What the recovery hint says about rerunning `adr init` after `git commit` failed (design 2b D5):
 * init keeps existing files, so it would commit nothing.
 */
export const INIT_RERUN =
  "Running adr init again won't commit them: the files exist now, so it keeps them and commits nothing.";

/** The line `adr init --skill` adds to AGENTS.md for tools that don't load skills. */
export const agentsPointer = (skill: string): string =>
  `Architecture decisions in this repository are managed by adr: read ${skill} before changing architecture, and follow it.`;

/** The starter config; `root` only for a repo-level file naming a log elsewhere. */
function configText(o: { readonly root: string | null; readonly template: string }): string {
  return [
    "# adr configuration. Every key is optional: https://github.com/nikovirtala/ark/tree/main/packages/adr#config-adrtoml",
    "[log]",
    ...(o.root === null ? [] : [`root = ${JSON.stringify(o.root)}`]),
    `default_template = ${JSON.stringify(o.template)}`,
    "",
    "[commit]",
    '# subject = "docs(adr): {action} {title}"',
    "",
  ].join("\n");
}

/**
 * `adr init` (design §6.2): writes a config for the log, unless one is found, and each built-in
 * template in `o.templates` (default `nygard`) to `<root>/templates/`, never overwriting a file.
 * A `--root` other than `docs/adr` gets a repo-level `adr.toml` naming it, so later commands find
 * the log without `--root`; when that file exists for another log, the config goes in the root.
 * With `[log] index = "committed"` it also writes `<root>/index.md` unless one exists. With
 * `commit` (default `[policy] auto_commit`) the written files are committed on their own;
 * nothing written means nothing committed. No events are written. With `o.skill` it also writes
 * the agent skill, unless a SKILL.md is there, and adds the pointer line to `AGENTS.md`, unless a
 * line already names the skill's path as a whole path (see `namesSkill`); an AGENTS.md with
 * unstaged changes or not tracked is refused with a commit and left unstaged without one.
 */
export async function initDecisionLog(
  log: DecisionLog,
  o: {
    readonly templates?: readonly string[];
    readonly commit?: boolean;
    readonly message?: string | null;
    /**
     * Also write `<dir>/SKILL.md` (`dir` repo-relative, `""` for the root) and the AGENTS.md
     * pointer (design §9); `version` is adr's, for the note on a SKILL.md that differs.
     */
    readonly skill?: {
      readonly dir?: string;
      readonly dirs?: readonly string[];
      readonly version: string;
    };
    /** Also write the agent setup (MCP config, hooks, permissions, prepare) for each harness. */
    readonly setup?: ToolSetup;
  } = {},
): Promise<InitResultJson> {
  const r = await initToolLog(
    log,
    {
      tool: "adr",
      config: log.adr,
      starterConfig: configText,
      builtins: BUILTIN_TEMPLATES,
      defaultTemplates: ["nygard"],
      templateChoices: "nygard, madr or y-statement",
      skillText: SKILL_MD,
      agentsPointer,
      // The index renders after the skill step, so index.md is no log file for the title.
      indexStep: "after-skill",
      renderIndex: (git, at) =>
        renderDecisionIndex(git, { layout: log.layout, adr: log.adr, ...at }),
      shallowNote: (at) =>
        `${at} not updated: numbers need history in this shallow clone; run git fetch --unshallow, then adr index`,
      indexAfter: INDEX_AFTER,
      rerun: INIT_RERUN,
      action: "set up",
      // Title by whether init wrote anything other than the skill files: adr's index step runs
      // after the skill step, so index.md never counts in logFiles (?57, rhb2vwnt). An index-only
      // committing run still sets up the decision log, not just the skill.
      commitTitle: ({ written, removed, skill }) =>
        removed.length === 0 && written.every((p) => p === skill || p === "AGENTS.md")
          ? "the adr agent skill"
          : "the decision log",
    },
    o,
  );
  const { root, config, written, kept, skill, commit, notes } = r;
  return { format: "adr-init/v1", root, config, written, kept, skill, commit, notes };
}
