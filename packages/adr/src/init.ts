import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  commitWithRecovery,
  firstLine,
  headTree,
  InvalidArgumentError,
  overlayTree,
  readToolConfig,
  renderCommitMessage,
  replaceFile,
  UsageError,
  withGitOperation,
  worktreeReader,
  writeIndexCopy,
  writeNewFile,
} from "@nikovirtala/ledger";
import { adrKind } from "./kind.js";
import type { DecisionLog } from "./log.js";
import { INDEX_AFTER, indexPath, renderDecisionIndex } from "./log-index.js";
import { SKILL_MD } from "./skill.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

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

const CONFIG = "adr.toml";
const DEFAULT_ROOT = adrKind.def.defaultRoot;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AGENTS = "AGENTS.md";

/** The line `adr init --skill` adds to AGENTS.md for tools that don't load skills. */
export const agentsPointer = (skill: string): string =>
  `Architecture decisions in this repository are managed by adr: read ${skill} before changing architecture, and follow it.`;

/** `text` with `line` appended after one blank line, ending with a newline. */
function appendLine(text: string, line: string): string {
  if (text === "") return `${line}\n`;
  const ended = text.endsWith("\n") ? text : `${text}\n`;
  return `${ended.endsWith("\n\n") ? ended : `${ended}\n`}${line}\n`;
}

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
 * Whether a line of `text` names `skill` as a whole path, optionally after `./`: not as the end of
 * a longer path (`SKILL.md` in `.claude/skills/adr/SKILL.md`) or the start of one (`SKILL.md.bak`).
 * A `.` right after it, ending a sentence, still counts.
 */
export function namesSkill(text: string, skill: string): boolean {
  const path = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_./-])(?:\\./)?${path}(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}_/-])`,
    "u",
  );
  return text.split("\n").some((line) => re.test(line));
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
 * line already names the skill's path as a whole path (see {@link namesSkill}); an AGENTS.md with
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
    readonly skill?: { readonly dir: string; readonly version: string };
  } = {},
): Promise<InitResultJson> {
  return withGitOperation(async () => {
    if (log.ref !== null || log.tree.label !== "worktree") {
      throw new InvalidArgumentError("init writes the work tree; open the log without a ref");
    }
    const known = Object.keys(BUILTIN_TEMPLATES);
    const templates = [...new Set(o.templates === undefined ? ["nygard"] : o.templates)];
    for (const name of templates) {
      if (!known.includes(name)) {
        throw new UsageError(`unknown built-in template ${name}; use nygard, madr or y-statement`);
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
      const template = templates[0] ?? "nygard";
      const repo = await readToolConfig(log.tree, CONFIG);
      if (root === DEFAULT_ROOT) {
        config = `${root}/${CONFIG}`;
        files.push([config, configText({ root: null, template })]);
      } else if (repo === null) {
        config = CONFIG;
        files.push([config, configText({ root, template })]);
      } else {
        // The repo file names another log (openToolLog ignored it with a note); leave it alone.
        const section = repo.raw.log as { root?: unknown } | undefined;
        const other = typeof section?.root === "string" ? section.root : DEFAULT_ROOT;
        config = `${root}/${CONFIG}`;
        files.push([config, configText({ root: null, template })]);
        notes.push(`${CONFIG} names ${other}; pass --root ${root} to use this log`);
      }
    }
    for (const name of templates) {
      const path = `${root}/templates/${name}.md`;
      if ((await log.tree.read(path)) !== null) kept.push(path);
      else files.push([path, BUILTIN_TEMPLATES[name] ?? ""]);
    }
    const commitRequested = o.commit ?? log.adr.autoCommit;
    const logFiles = files.length;

    // The skill (design §9.1): SKILL.md is never overwritten; AGENTS.md gets one pointer line.
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
            `${skill} differs from adr ${o.skill?.version ?? ""}'s skill; delete it and run adr init --skill again to replace it`,
          );
        }
      }
      const old = await log.tree.read(AGENTS);
      const text = old === null ? null : decoder.decode(old);
      if (namesSkill(text ?? "", skill)) {
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
    const at = indexPath(log.layout);
    let indexed = false;
    if (log.adr.index === "committed") {
      // Rendered before anything is written, from the tree the commit (or the work tree) will hold.
      if ((await log.tree.read(at)) !== null) {
        kept.push(at);
      } else {
        const head = await log.git.resolveCommit("HEAD");
        const added = Object.fromEntries(files.map(([p, t]) => [p, encoder.encode(t)]));
        const base = commitRequested ? await headTree(log.git, head) : log.tree;
        const text = await renderDecisionIndex(log.git, {
          layout: log.layout,
          adr: log.adr,
          tree: overlayTree(base, added),
          history: head,
        });
        if (text === null) {
          notes.push(
            `${at} not updated: numbers need history in this shallow clone; run git fetch --unshallow, then adr index`,
          );
        } else {
          files.push([at, text]);
          indexed = true;
        }
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
    let sha: string | null = null;
    if (commit) {
      const message =
        o.message ??
        renderCommitMessage(log.adr.commitSubject, {
          title: logFiles > 0 ? "the decision log" : "the adr agent skill",
          vars: { action: "set up", id: "", display: "", command: "init" },
        }).message;
      sha = await commitWithRecovery(log.git, {
        message,
        only: staged,
        rerun: INIT_RERUN,
        after: indexed ? INDEX_AFTER(root) : null,
      });
      if (indexed) {
        // The commit's index leaves out uncommitted log changes; the work tree and the index get
        // them back (design 2b §4.5 step 5).
        try {
          const again = await renderDecisionIndex(log.git, {
            layout: log.layout,
            adr: log.adr,
            tree: worktreeReader(log.git),
            history: sha,
          });
          if (again !== null) {
            const r = await writeIndexCopy(log.git, at, again);
            if (r.stage) await log.git.add([at]);
          }
        } catch (err) {
          notes.push(`${at} may be stale: ${firstLine(err)}; run adr index`);
        }
      }
    }
    return { format: "adr-init/v1", root, config, written, kept, skill, commit: sha, notes };
  });
}
