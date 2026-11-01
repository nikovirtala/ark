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
import { applySetup, type SetupPiece } from "./setup.js";
import {
  claudePieces,
  type Harness,
  type HarnessShared,
  type McpServerEntry,
} from "./setup-claude.js";
import { kiroPieces } from "./setup-kiro.js";
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
   * Also write the agent skill as `<dir>/SKILL.md` and the AGENTS.md pointer. A single `dir`
   * writes one skill; `dirs` writes one SKILL.md per directory (a harness each, e.g.
   * `.claude/skills/<tool>` and `.kiro/skills/<tool>`). A directory is repo-relative, `""` for
   * the root. The AGENTS.md pointer names the first directory's skill. `version` is the tool's,
   * for the note on a SKILL.md that differs.
   */
  readonly skill?: {
    readonly dir?: string;
    readonly dirs?: readonly string[];
    readonly version: string;
  };
  /**
   * Also write the agent setup (MCP config, harness hooks, permission rules and a `prepare`
   * script) for the harnesses in {@link ToolSetup.harnesses}, owning only what init wrote and safe
   * to rerun (design "init: complete by default, safe to rerun"). Omitted means no setup is
   * written, so the existing log/skill behaviour is unchanged.
   */
  readonly setup?: ToolSetup;
}

/**
 * The agent-setup content a tool's init writes, supplied by the tool because it is tool- and
 * repo-specific (the pins, the `ARK_AGENT` value, the hook scripts and the deny globs). init turns
 * it into the per-harness pieces and applies them with {@link applySetup}.
 */
export interface ToolSetup {
  /** The harnesses to write, after detection and `--harness`/`--no-*` opt-outs. */
  readonly harnesses: readonly Harness[];
  /** This tool's MCP server entry per harness (merged under `mcpServers.<name>`). */
  readonly servers: Readonly<Record<Harness, McpServerEntry>>;
  /** The exact file contents of the shared, ark-specific pieces per harness. */
  readonly shared: Readonly<Record<Harness, HarnessShared>>;
  /** The `scripts.prepare` value for `package.json`, or `null` to write none. */
  readonly prepare?: string | null;
  /** Opt out of a piece/harness: piece ids (e.g. `mcp`, `hooks`) or harness names, pre-expanded. */
  readonly skip?: ReadonlySet<string>;
  /** Overwrite a piece even when someone changed it, by piece id (`init --force <piece>`). */
  readonly force?: ReadonlySet<string>;
}

/** The SKILL.md path a skill directory writes (`""` is the repo root). */
function skillPath(dir: string): string {
  return dir === "" ? "SKILL.md" : `${dir}/SKILL.md`;
}

/** The setup pieces a {@link ToolSetup} asks for: the per-harness pieces plus the prepare script. */
function setupPieces(setup: ToolSetup): SetupPiece[] {
  const pieces: SetupPiece[] = [];
  for (const h of setup.harnesses) {
    const server = setup.servers[h];
    const shared = setup.shared[h];
    const built =
      h === "claude" ? claudePieces({ server, shared }) : kiroPieces({ server, shared });
    pieces.push(...built);
  }
  if (setup.prepare !== undefined && setup.prepare !== null) {
    pieces.push({
      id: "prepare",
      file: "package.json",
      ownership: {
        kind: "merge",
        scaffold: { scripts: {} },
        entries: { "scripts.prepare": setup.prepare },
        front: ["scripts.prepare"],
      },
    });
  }
  return pieces;
}

/** The groups a piece id belongs to, for `--no-mcp` / `--no-hooks` opt-outs. */
function pieceGroups(id: string): readonly string[] {
  if (id.includes(".mcp.")) return ["mcp"];
  if (id.includes(".hook.") || id === "prepare") return ["hooks"];
  if (id.endsWith(".settings")) return ["hooks"];
  return [];
}

/**
 * Expands the opt-out `skip` groups (`mcp`, `hooks`) and raw piece ids into the concrete piece ids
 * {@link applySetup} skips. A group name opts out every piece in it; a piece id opts out that one.
 */
function expandSkip(
  skip: ReadonlySet<string> | undefined,
  pieces: readonly SetupPiece[],
): ReadonlySet<string> {
  const out = new Set<string>();
  if (skip === undefined) return out;
  for (const piece of pieces) {
    if (skip.has(piece.id) || pieceGroups(piece.id).some((g) => skip.has(g))) out.add(piece.id);
  }
  return out;
}

/** The skill directories a {@link ToolInitOptions.skill} asks for, in order, de-duplicated. */
function skillDirs(skill: ToolInitOptions["skill"]): readonly string[] {
  if (skill === undefined) return [];
  const dirs = skill.dirs ?? (skill.dir === undefined ? [] : [skill.dir]);
  return [...new Set(dirs)];
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
 * commit. With `o.skill` it also writes the agent skill to each requested directory (one `dir`,
 * or several `dirs`, one SKILL.md per harness), unless a SKILL.md is there, and adds one pointer
 * line to `AGENTS.md` naming the first directory's skill, unless a line already names it (see
 * {@link namesSkill}); an AGENTS.md with unstaged changes or not tracked is refused with a commit
 * and left unstaged without one. A failed write removes what init wrote.
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

    // The skill: each SKILL.md is never overwritten; AGENTS.md gets one pointer line naming the
    // first directory's skill. Checked before anything is written.
    const dirs = skillDirs(o.skill);
    const skillPaths = dirs.map(skillPath);
    const skill = skillPaths[0] ?? null;
    let agents: {
      readonly bytes: Uint8Array;
      readonly expected: Uint8Array | null;
      readonly stage: boolean;
    } | null = null;
    if (skill !== null) {
      for (const path of skillPaths) {
        const current = await log.tree.read(path);
        if (current === null) {
          files.push([path, t.skillText]);
        } else {
          kept.push(path);
          if (decoder.decode(current) !== t.skillText) {
            notes.push(
              `${path} differs from ${t.tool} ${o.skill?.version ?? ""}'s skill; delete it and run ${t.tool} init --skill again to replace it`,
            );
          }
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

    const commit =
      (files.length > 0 || agents !== null || (o.setup?.harnesses.length ?? 0) > 0) &&
      commitRequested;
    if (
      commit &&
      ((await log.git.identity()) === null || (await log.git.committerIdentity()) === null)
    ) {
      throw new ConfigError("--commit needs a git identity; set git user.name and user.email");
    }
    const written: string[] = [];
    try {
      for (const [path, text] of files) {
        await writeNewFile(log.git, path, encoder.encode(text));
        written.push(path);
      }
      if (agents !== null) {
        if (agents.expected === null) await writeNewFile(log.git, AGENTS, agents.bytes);
        else await replaceFile(log.git, AGENTS, agents.bytes, { expected: agents.expected });
        written.push(AGENTS);
      }
    } catch (err) {
      const top = log.git.root ?? "";
      for (const path of written) {
        await rm(join(top, path), { force: true });
      }
      throw err;
    }
    const staged = written.filter((p) => p !== AGENTS || agents?.stage === true);
    if (staged.length > 0) await log.git.add(staged);

    // The agent setup: MCP config, harness hooks, permission rules and a prepare script, owned by
    // init and safe to rerun. Its written files are staged and committed with the rest.
    const setupStaged: string[] = [];
    if (o.setup !== undefined && o.setup.harnesses.length > 0) {
      const pieces = setupPieces(o.setup);
      const skip = expandSkip(o.setup.skip, pieces);
      const r = await applySetup(log.git, pieces, {
        tool: t.tool,
        skip,
        ...(o.setup.force === undefined ? {} : { force: o.setup.force }),
      });
      for (const path of r.written) {
        if (!written.includes(path)) written.push(path);
        setupStaged.push(path);
      }
      await log.git.add(setupStaged);
      notes.push(...r.notes);
    }

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
        only: [...staged, ...setupStaged, ...tracked],
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
