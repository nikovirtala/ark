import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, InvalidArgumentError, UsageError } from "../errors.js";
import { withGitOperation } from "../git/operation.js";
import { indexReader, overlayTree, worktreeReader } from "../git/tree.js";
import { replaceFile, writeNewFile } from "../log/write.js";
import { firstLine, headBytes, headTree, writeIndexCopy } from "../log-index/copies.js";
import { indexPath } from "../log-index/tool-render.js";
import { readToolConfig } from "../sources/config.js";
import { renderCommitMessage } from "./commit-message.js";
import { commitWithRecovery } from "./commit-recovery.js";
import type { LogIndexRender } from "./tool-index.js";
import type { SharedKeys, ToolLog } from "./tool-log.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AGENTS = "AGENTS.md";

/** What a tool's init passes in: its domain (config text, templates, skill, titles). */
export interface ToolInitSpec {
  /** The tool's name: its config file is `<tool>.toml`, and the notes name `<tool> init`. */
  readonly tool: string;
  /** The log's `[log] index`, `[policy] auto_commit` and `[commit] subject`. */
  readonly config: Pick<SharedKeys, "index" | "autoCommit" | "commitSubject">;
  /** The starter config; `root` only for a repo-level file naming a log elsewhere. */
  readonly starterConfig: (o: {
    readonly root: string | null;
    readonly template: string;
  }) => string;
  /** The built-in templates by name. */
  readonly builtins: Readonly<Record<string, string>>;
  /** The templates written without `templates`; the first one is the config's fallback. */
  readonly defaultTemplates: readonly string[];
  /** Whether an empty `templates` list also means `defaultTemplates`; default `false`. */
  readonly defaultWhenEmpty?: boolean;
  /** The names an unknown template's error offers: `use <templateChoices>`. */
  readonly templateChoices: string;
  /** The agent skill's SKILL.md text. */
  readonly skillText: string;
  /** The line AGENTS.md gets for tools that don't load skills, naming the skill's path. */
  readonly agentsPointer: (skill: string) => string;
  /**
   * Where the committed-index step runs: before the skill step, so `index.md` counts as a log
   * file, or after it, so it doesn't and an unusable AGENTS.md is refused before rendering.
   */
  readonly indexStep: "before-skill" | "after-skill";
  /** The tool's index render (`renderLogIndex` with its spec bound). */
  readonly renderIndex: LogIndexRender;
  /** The note when a shallow clone can't number the index at `at`. */
  readonly shallowNote: (at: string) => string;
  /** The recovery hint's step after the manual commit when the commit carried the index. */
  readonly indexAfter: (root: string) => string;
  /** What the recovery hint says about rerunning init after `git commit` failed. */
  readonly rerun: string;
  /** The commit's `{action}`. */
  readonly action: string;
  /** The commit's `{title}`, from what init wrote (`logFiles`: the log files among them). */
  readonly commitTitle: (o: {
    readonly logFiles: number;
    readonly written: readonly string[];
    readonly removed: readonly string[];
    readonly skill: string | null;
  }) => string;
  /**
   * Remove an empty `<root>/.gitkeep` placeholder once init writes a log file, and stage and
   * commit the deletion; a non-empty one is kept with a note. Default `false`.
   */
  readonly removePlaceholder?: boolean;
}

/** What the user asked init for. */
export interface ToolInitOptions {
  readonly templates?: readonly string[];
  /** Commit what init writes; default `[policy] auto_commit`. */
  readonly commit?: boolean;
  readonly message?: string | null;
  /**
   * Also write `<dir>/SKILL.md` (`dir` repo-relative, `""` for the root) and the AGENTS.md
   * pointer; `version` is the tool's, for the note on a SKILL.md that differs.
   */
  readonly skill?: { readonly dir: string; readonly version: string };
}

export interface ToolInitResult {
  readonly root: string;
  /** The config file of the log after init, repo-relative. */
  readonly config: string | null;
  /** Repo-relative paths written, in write order. */
  readonly written: readonly string[];
  /** Files that were already there and were left as they are. */
  readonly kept: readonly string[];
  /** Placeholders removed; always empty without `removePlaceholder`. */
  readonly removed: readonly string[];
  /** With `skill`, the SKILL.md path (written or kept); else `null`. */
  readonly skill: string | null;
  readonly commit: string | null;
  readonly notes: readonly string[];
}

/** `text` with `line` appended after one blank line, ending with a newline. */
function appendLine(text: string, line: string): string {
  if (text === "") return `${line}\n`;
  const ended = text.endsWith("\n") ? text : `${text}\n`;
  return `${ended.endsWith("\n\n") ? ended : `${ended}\n`}${line}\n`;
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
 * `<tool> init`: writes a config for the log, unless one is found, and each chosen built-in
 * template to `<root>/templates/<name>.md`, never overwriting a file. A root other than the
 * kind's default gets a repo-level `<tool>.toml` naming it, so later commands find the log
 * without `--root`; when that file exists for another log, the config goes in the root, with a
 * note. With `[log] index = "committed"` it also writes `<root>/index.md` unless one exists,
 * rendered from the tree the commit (or the work tree) will hold, and refreshes it after the
 * commit. With `o.skill` it also writes the agent skill, unless a SKILL.md is there, and adds the
 * pointer line to `AGENTS.md`, unless a line already names the skill's path as a whole path (see
 * {@link namesSkill}); an AGENTS.md with unstaged changes or not tracked is refused with a commit
 * and left unstaged without one. A failed write removes what init wrote and restores AGENTS.md.
 * With a commit (default `[policy] auto_commit`) only what init wrote and removed is committed;
 * nothing written means nothing committed. No events are written.
 */
export async function initToolLog(
  log: ToolLog,
  t: ToolInitSpec,
  o: ToolInitOptions = {},
): Promise<ToolInitResult> {
  return withGitOperation(async () => {
    if (log.ref !== null || log.tree.label !== "worktree") {
      throw new InvalidArgumentError("init writes the work tree; open the log without a ref");
    }
    const known = Object.keys(t.builtins);
    const useDefault =
      o.templates === undefined || (t.defaultWhenEmpty === true && o.templates.length === 0);
    const templates = [...new Set(useDefault ? t.defaultTemplates : (o.templates ?? []))];
    for (const name of templates) {
      if (!known.includes(name)) {
        throw new UsageError(`unknown built-in template ${name}; use ${t.templateChoices}`);
      }
    }
    const file = `${t.tool}.toml`;
    const defaultRoot = log.kind.def.defaultRoot;
    const root = log.layout.root;
    const notes = [...log.notes];
    const files: [string, string][] = [];
    const kept: string[] = [];
    let config = log.configPath;
    if (config !== null) {
      kept.push(config);
    } else {
      const template = templates[0] ?? t.defaultTemplates[0] ?? "";
      const repo = await readToolConfig(log.tree, file);
      if (root === defaultRoot) {
        config = `${root}/${file}`;
        files.push([config, t.starterConfig({ root: null, template })]);
      } else if (repo === null) {
        config = file;
        files.push([config, t.starterConfig({ root, template })]);
      } else {
        // The repo file names another log (openToolLog ignored it with a note); leave it alone.
        const section = repo.raw.log as { root?: unknown } | undefined;
        const other = typeof section?.root === "string" ? section.root : defaultRoot;
        config = `${root}/${file}`;
        files.push([config, t.starterConfig({ root: null, template })]);
        notes.push(`${file} names ${other}; pass --root ${root} to use this log`);
      }
    }
    for (const name of templates) {
      const path = `${root}/templates/${name}.md`;
      if ((await log.tree.read(path)) !== null) kept.push(path);
      else files.push([path, t.builtins[name] ?? ""]);
    }
    const commitRequested = o.commit ?? t.config.autoCommit;

    const at = indexPath(log.layout);
    let indexed = false;
    // Rendered before anything is written, from the tree the commit (or the work tree) will hold.
    const indexStep = async () => {
      if (t.config.index !== "committed") return;
      if ((await log.tree.read(at)) !== null) {
        kept.push(at);
        return;
      }
      const head = await log.git.resolveCommit("HEAD");
      const added = Object.fromEntries(files.map(([p, text]) => [p, encoder.encode(text)]));
      const base = commitRequested ? await headTree(log.git, head) : log.tree;
      const text = await t.renderIndex(log.git, { tree: overlayTree(base, added), history: head });
      if (text === null) {
        notes.push(t.shallowNote(at));
      } else {
        files.push([at, text]);
        indexed = true;
      }
    };
    if (t.indexStep === "before-skill") await indexStep();
    const logFiles = files.length;

    // The skill: SKILL.md is never overwritten; AGENTS.md gets one pointer line. Checked before
    // anything is written.
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
        files.push([skill, t.skillText]);
      } else {
        kept.push(skill);
        if (decoder.decode(current) !== t.skillText) {
          notes.push(
            `${skill} differs from ${t.tool} ${o.skill?.version ?? ""}'s skill; delete it and run ${t.tool} init --skill again to replace it`,
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
          bytes: encoder.encode(appendLine(text ?? "", t.agentsPointer(skill))),
          expected: old,
          stage,
        };
      }
    }
    if (t.indexStep === "after-skill") await indexStep();

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
    if (t.removePlaceholder === true && logFiles > 0) {
      const keep = `${root}/.gitkeep`;
      const work = await worktreeReader(log.git).read(keep);
      const head = await headBytes(log.git, keep);
      const inIndex = await (await indexReader(log.git)).read(keep);
      const bytes = work ?? inIndex ?? head;
      if (bytes !== null && bytes.byteLength > 0) {
        notes.push(`kept ${keep}: it isn't empty`);
      } else if (bytes !== null) {
        if (work !== null) await rm(join(log.git.root ?? "", keep), { force: true });
        if (inIndex !== null) await log.git.add([keep]);
        removed.push(keep);
        // Only HEAD's placeholder has a deletion to commit; a new or untracked one is just gone.
        if (head !== null) tracked.push(keep);
      }
    }
    let sha: string | null = null;
    if (commit) {
      const message =
        o.message ??
        renderCommitMessage(t.config.commitSubject, {
          title: t.commitTitle({ logFiles, written, removed, skill }),
          vars: { action: t.action, id: "", display: "", command: "init" },
        }).message;
      sha = await commitWithRecovery(log.git, {
        message,
        only: [...staged, ...tracked],
        rerun: t.rerun,
        after: indexed ? t.indexAfter(root) : null,
      });
      if (indexed) {
        // The commit's index leaves out uncommitted log changes; the work tree and the index get
        // them back (design 2b §4.5 step 5).
        try {
          const again = await t.renderIndex(log.git, {
            tree: worktreeReader(log.git),
            history: sha,
          });
          if (again !== null) {
            const r = await writeIndexCopy(log.git, at, again);
            if (r.stage) await log.git.add([at]);
          }
        } catch (err) {
          notes.push(`${at} may be stale: ${firstLine(err)}; run ${t.tool} index`);
        }
      }
    }
    return { root, config, written, kept, removed, skill, commit: sha, notes };
  });
}
