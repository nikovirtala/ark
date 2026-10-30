import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  commitWithRecovery,
  headBytes,
  InvalidArgumentError,
  indexReader,
  readToolConfig,
  renderCommitMessage,
  replaceFile,
  UsageError,
  withGitOperation,
  worktreeReader,
  writeNewFile,
} from "@nikovirtala/ledger";
import { ACTIONS, INIT_TITLE, SKILL_TITLE } from "./commit-actions.js";
import { issueKind } from "./kind.js";
import type { IssueLog } from "./log.js";
import { indexPath, renderIssueIndex } from "./log-index.js";
import { SKILL_MD } from "./skill.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

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

const CONFIG = "issues.toml";
const DEFAULT_ROOT = issueKind.def.defaultRoot;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AGENTS = "AGENTS.md";

/** The line `issues init --skill` adds to AGENTS.md for tools that don't load skills. */
export const agentsPointer = (skill: string): string =>
  `Issues in this repository are tracked with issues: read ${skill} before starting, continuing or finishing work, and follow it.`;

/**
 * Whether `line` names `path` as a whole path: not as the end of a longer one, as `SKILL.md`
 * ends `.claude/skills/adr/SKILL.md`, nor as the start of one. A leading `./` still counts.
 */
function namesPath(line: string, path: string): boolean {
  const pathChar = /[\w./-]/;
  for (let at = line.indexOf(path); at !== -1; at = line.indexOf(path, at + 1)) {
    const start = line.startsWith("./", at - 2) ? at - 2 : at;
    const before = line[start - 1] ?? "";
    const after = line.slice(at + path.length, at + path.length + 2);
    const continues = /^[\w/-]/.test(after) || /^\.[\w/-]/.test(after);
    if (!pathChar.test(before) && !continues) return true;
  }
  return false;
}

/** `text` with `line` appended after one blank line, ending with a newline. */
function appendLine(text: string, line: string): string {
  if (text === "") return `${line}\n`;
  const ended = text.endsWith("\n") ? text : `${text}\n`;
  return `${ended.endsWith("\n\n") ? ended : `${ended}\n`}${line}\n`;
}

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
 * the pointer line to `AGENTS.md`, unless a line already names the skill; an AGENTS.md with
 * unstaged changes or not tracked is refused with a commit and left unstaged without one.
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
    readonly skill?: { readonly dir: string; readonly version: string };
  } = {},
): Promise<IssuesInitJson> {
  return withGitOperation(async () => {
    if (log.ref !== null || log.tree.label !== "worktree") {
      throw new InvalidArgumentError("init writes the work tree; open the log without a ref");
    }
    const known = Object.keys(BUILTIN_TEMPLATES);
    const templates = [
      ...new Set(o.templates === undefined || o.templates.length === 0 ? ["task"] : o.templates),
    ];
    for (const name of templates) {
      if (!known.includes(name)) {
        throw new UsageError(`unknown built-in template ${name}; use ${known.sort().join(", ")}`);
      }
    }
    const root = log.layout.root;
    const notes = [...log.notes];
    const files: [string, string][] = [];
    const kept: string[] = [];
    let config = log.configPath;
    if (config !== null) {
      kept.push(config);
    } else {
      const template = templates[0] ?? "task";
      const repo = await readToolConfig(log.tree, CONFIG);
      if (root === DEFAULT_ROOT) {
        config = `${root}/${CONFIG}`;
        files.push([config, starterConfig({ root: null, template })]);
      } else if (repo === null) {
        config = CONFIG;
        files.push([config, starterConfig({ root, template })]);
      } else {
        // The repo file names another log (openToolLog ignored it with a note); leave it alone.
        const section = repo.raw.log as { root?: unknown } | undefined;
        const other = typeof section?.root === "string" ? section.root : DEFAULT_ROOT;
        config = `${root}/${CONFIG}`;
        files.push([config, starterConfig({ root: null, template })]);
        notes.push(`${CONFIG} names ${other}; pass --root ${root} to use this log`);
      }
    }
    for (const name of templates) {
      const path = `${root}/templates/${name}.md`;
      if ((await log.tree.read(path)) !== null) kept.push(path);
      else files.push([path, BUILTIN_TEMPLATES[name] ?? ""]);
    }
    // A kept config with `[log] index = "committed"` gets its index, as adr's init does; an
    // existing index.md is kept.
    if (log.issues.index === "committed") {
      const path = indexPath(log.layout);
      if ((await log.tree.read(path)) !== null) {
        kept.push(path);
      } else {
        const text = await renderIssueIndex(log.git, {
          layout: log.layout,
          issues: log.issues,
          tree: log.tree,
          history: await log.git.resolveCommit("HEAD"),
        });
        if (text === null) {
          notes.push(
            `${path} not written: numbers need history in this shallow clone; run git fetch --unshallow, then issues index`,
          );
        } else {
          files.push([path, text]);
        }
      }
    }
    const commitRequested = o.commit ?? log.issues.autoCommit;
    const logFiles = files.length;

    // The skill (design §8.2): SKILL.md is never overwritten; AGENTS.md gets one pointer line.
    // Checked before anything is written.
    const skill =
      o.skill === undefined ? null : o.skill.dir === "" ? "SKILL.md" : `${o.skill.dir}/SKILL.md`;
    let agents: {
      readonly bytes: Uint8Array;
      readonly expected: Uint8Array | null;
      readonly stage: boolean;
    } | null = null;
    if (skill !== null) {
      const current = await log.tree.read(skill);
      if (current === null) {
        files.push([skill, SKILL_MD]);
      } else {
        kept.push(skill);
        if (decoder.decode(current) !== SKILL_MD) {
          notes.push(
            `${skill} differs from issues ${o.skill?.version ?? ""}'s skill; delete it and run issues init --skill again to replace it`,
          );
        }
      }
      const old = await log.tree.read(AGENTS);
      const text = old === null ? null : decoder.decode(old);
      if ((text ?? "").split("\n").some((l) => namesPath(l, skill))) {
        kept.push(AGENTS);
      } else {
        let stage = true;
        if (old !== null) {
          const unstaged = (await log.git.unstagedPaths([AGENTS])).length > 0;
          const untracked = (await log.git.untrackedPaths([AGENTS])).length > 0;
          if (commitRequested && unstaged) {
            throw new UsageError(
              `${AGENTS} has unstaged changes; stage or discard them, or run without --commit`,
            );
          }
          if (commitRequested && untracked) {
            throw new UsageError(`${AGENTS} is not tracked; git add it, or run without --commit`);
          }
          if (unstaged || untracked) {
            stage = false;
            notes.push(
              untracked
                ? `${AGENTS} is not tracked, so the pointer is added but not staged; review it and git add it`
                : `${AGENTS} had unstaged changes, so the pointer is added but not staged; review it and git add it`,
            );
          }
        }
        agents = {
          bytes: encoder.encode(appendLine(text ?? "", agentsPointer(skill))),
          expected: old,
          stage,
        };
      }
    }

    const commit = (files.length > 0 || agents !== null) && commitRequested;
    if (
      commit &&
      ((await log.git.identity()) === null || (await log.git.committerIdentity()) === null)
    ) {
      throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
    }
    const written: string[] = [];
    let replaced = false;
    try {
      for (const [path, text] of files) {
        await writeNewFile(log.git, path, encoder.encode(text));
        written.push(path);
      }
      if (agents !== null) {
        if (agents.expected === null) await writeNewFile(log.git, AGENTS, agents.bytes);
        else await replaceFile(log.git, AGENTS, agents.bytes, { expected: agents.expected });
        replaced = agents.expected !== null;
        written.push(AGENTS);
      }
    } catch (err) {
      const top = log.git.root ?? "";
      const restore = replaced ? (agents?.expected ?? null) : null;
      for (const path of written) {
        if (path === AGENTS && restore !== null && agents !== null) {
          await replaceFile(log.git, AGENTS, restore, { expected: agents.bytes }).catch(() => {});
        } else {
          await rm(join(top, path), { force: true });
        }
      }
      throw err;
    }
    const staged = written.filter((p) => p !== AGENTS || agents?.stage === true);
    if (staged.length > 0) await log.git.add(staged);
    // The placeholder goes once the log has real files (not for the skill alone): after the
    // writes, so a failed write leaves it alone.
    const removed: string[] = [];
    const tracked: string[] = [];
    if (logFiles > 0) {
      const keep = `${root}/.gitkeep`;
      const work = await worktreeReader(log.git).read(keep);
      const head = await headBytes(log.git, keep);
      const staged = await (await indexReader(log.git)).read(keep);
      const bytes = work ?? staged ?? head;
      if (bytes !== null && bytes.byteLength > 0) {
        notes.push(`kept ${keep}: it isn't empty`);
      } else if (bytes !== null) {
        if (work !== null) await rm(join(log.git.root ?? "", keep), { force: true });
        if (staged !== null) await log.git.add([keep]);
        removed.push(keep);
        // Only HEAD's placeholder has a deletion to commit; a new or untracked one is just gone.
        if (head !== null) tracked.push(keep);
      }
    }
    let sha: string | null = null;
    if (commit) {
      const message =
        o.message ??
        renderCommitMessage(log.issues.commitSubject, {
          title:
            removed.length === 0 && written.every((p) => p === skill || p === AGENTS)
              ? SKILL_TITLE
              : INIT_TITLE,
          vars: { action: ACTIONS.init, id: "", display: "", command: "init" },
        }).message;
      sha = await commitWithRecovery(log.git, {
        message,
        only: [...staged, ...tracked],
        rerun: INIT_RERUN,
      });
    }
    return {
      format: "issues-init/v1",
      root,
      config,
      written,
      kept,
      removed,
      skill,
      commit: sha,
      notes,
    };
  });
}
