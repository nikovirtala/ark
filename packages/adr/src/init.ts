import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  commitWithRecovery,
  InvalidArgumentError,
  overlayTree,
  readToolConfig,
  renderCommitMessage,
  UsageError,
  worktreeReader,
  writeNewFile,
} from "@nikovirtala/ledger";
import { adrKind } from "./kind.js";
import type { DecisionLog } from "./log.js";
import {
  firstLine,
  headTree,
  INDEX_AFTER,
  indexPath,
  renderDecisionIndex,
  writeIndexCopy,
} from "./log-index.js";
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
 * nothing written means nothing committed. No events are written.
 */
export async function initDecisionLog(
  log: DecisionLog,
  o: {
    readonly templates?: readonly string[];
    readonly commit?: boolean;
    readonly message?: string | null;
  } = {},
): Promise<InitResultJson> {
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

  const commit = files.length > 0 && commitRequested;
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
  } catch (err) {
    const top = log.git.root ?? "";
    for (const path of written) await rm(join(top, path), { force: true });
    throw err;
  }
  if (written.length > 0) await log.git.add(written);
  let sha: string | null = null;
  if (commit) {
    const message =
      o.message ??
      renderCommitMessage(log.adr.commitSubject, {
        title: "the decision log",
        vars: { action: "set up", id: "", display: "", command: "init" },
      }).message;
    sha = await commitWithRecovery(log.git, {
      message,
      only: written,
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
  return { format: "adr-init/v1", root, config, written, kept, commit: sha, notes };
}
