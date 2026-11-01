import { initToolLog, type ToolSetup } from "@nikovirtala/ledger";
import { ACTIONS, INIT_TITLE, SKILL_TITLE } from "./commit-actions.js";
import type { IssueLog } from "./log.js";
import { INDEX_AFTER, renderIssueIndex } from "./log-index.js";
import { SKILL_MD } from "./skill.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

export { namesSkill } from "@nikovirtala/ledger";

/** `issues init --json`. */
export interface IssuesInitJson {
  readonly format: "issues-init/v1";
  readonly root: string;
  /** The config file, written or kept; `null` never in this version. */
  readonly config: string | null;
  readonly written: readonly string[];
  readonly kept: readonly string[];
  /** Placeholders removed (an empty `<root>/.gitkeep`), the deletion staged and committed with them. */
  readonly removed: readonly string[];
  /** With `--skill`, the SKILL.md path (written or kept); else `null`. */
  readonly skill: string | null;
  readonly commit: string | null;
  readonly notes: readonly string[];
}

/** What the recovery hint says about rerunning `issues init` after `git commit` failed. */
export const INIT_RERUN =
  "Running issues init again won't commit them: the files exist now, so it keeps them and commits nothing.";

/** The line `issues init --skill` adds to AGENTS.md for tools that don't load skills. */
export const agentsPointer = (skill: string): string =>
  `Issues in this repository are tracked with issues: read ${skill} before starting, continuing or finishing work, and follow it.`;

/** The starter config; `root` only for a repo-level file naming a log elsewhere. */
export function starterConfig(o: {
  readonly root: string | null;
  readonly template: string;
}): string {
  return [
    "# issues configuration. Every key is optional: https://github.com/nikovirtala/ark/tree/main/packages/issues#config-issuestoml",
    "[log]",
    ...(o.root === null ? [] : [`root = ${JSON.stringify(o.root)}`]),
    `default_template = ${JSON.stringify(o.template)}`,
    '# "none", or "committed" to keep index.md generated and fresh in every commit (ADR-0010)',
    'index = "none"',
    "",
    "[labels]",
    'exclusive = ["priority", "type"]',
    "",
    "[policy]",
    "close_requires_human = false",
    "mcp_can_close = true",
    "",
    "[commit]",
    '# {title} holds the title in quotes for new, and the issue\'s number (or id on a branch) with its title in quotes for every other write, as in: close ?42 "split the orders service".',
    '# subject = "docs(issues): {action} {title}"',
    "",
  ].join("\n");
}

/**
 * `issues init`: writes the starter config unless the log has one, and each chosen built-in
 * template (default `task`) to `<root>/templates/<name>.md`, never overwriting a file; reports
 * what it wrote and kept. A `--root` other than `docs/issues` gets a repo-level `issues.toml`
 * naming it, as adr's init does, so later commands find the log. No events are written. Once it
 * writes a log file, an empty `<root>/.gitkeep` placeholder is removed and the deletion staged
 * (?8); a non-empty one is kept with a note. With `commit`, commits only what it wrote and
 * removed. With `o.skill` it also writes the agent skill, unless a SKILL.md is there, and adds
 * the pointer line to `AGENTS.md`, unless a line already names the skill's path as a whole path
 * (see `namesSkill`); an AGENTS.md with unstaged changes or not tracked is refused with a
 * commit and left unstaged without one.
 */
export async function initIssueLog(
  log: IssueLog,
  o: {
    readonly templates?: readonly string[];
    readonly commit?: boolean;
    readonly message?: string | null;
    /**
     * Also write `<dir>/SKILL.md` (`dir` repo-relative, `""` for the root) and the AGENTS.md
     * pointer (design §8.2); `version` is issues', for the note on a SKILL.md that differs.
     */
    readonly skill?: {
      readonly dir?: string;
      readonly dirs?: readonly string[];
      readonly version: string;
    };
    /** Also write the agent setup (MCP config, hooks, permissions, prepare) for each harness. */
    readonly setup?: ToolSetup;
  } = {},
): Promise<IssuesInitJson> {
  const r = await initToolLog(
    log,
    {
      tool: "issues",
      config: log.issues,
      starterConfig,
      builtins: BUILTIN_TEMPLATES,
      defaultTemplates: ["task"],
      defaultWhenEmpty: true,
      templateChoices: Object.keys(BUILTIN_TEMPLATES).sort().join(", "),
      skillText: SKILL_MD,
      agentsPointer,
      // The index renders before the skill step, so index.md counts as a log file.
      indexStep: "before-skill",
      renderIndex: (git, at) =>
        renderIssueIndex(git, { layout: log.layout, issues: log.issues, ...at }),
      shallowNote: (at) =>
        `${at} not written: numbers need history in this shallow clone; run git fetch --unshallow, then issues index`,
      indexAfter: INDEX_AFTER,
      rerun: INIT_RERUN,
      action: ACTIONS.init,
      commitTitle: ({ written, removed, skill }) =>
        removed.length === 0 && written.every((p) => p === skill || p === "AGENTS.md")
          ? SKILL_TITLE
          : INIT_TITLE,
      removePlaceholder: true,
    },
    o,
  );
  const { root, config, written, kept, removed, skill, commit, notes } = r;
  return {
    format: "issues-init/v1",
    root,
    config,
    written,
    kept,
    removed,
    skill,
    commit,
    notes,
  };
}
