import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigError,
  commitWithRecovery,
  InvalidArgumentError,
  readToolConfig,
  renderCommitMessage,
  UsageError,
  writeNewFile,
} from "@nikovirtala/ledger";
import { ACTIONS, INIT_TITLE } from "./commit-actions.js";
import { issueKind } from "./kind.js";
import type { IssueLog } from "./log.js";
import { BUILTIN_TEMPLATES } from "./templates/builtin.js";

/** `issues init --json`. */
export interface IssuesInitJson {
  readonly format: "issues-init/v1";
  readonly root: string;
  /** The config file, written or kept; `null` never in this version. */
  readonly config: string | null;
  readonly written: readonly string[];
  readonly kept: readonly string[];
  /** The agent skill's path; always `null` in this version. */
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
    "",
    "[labels]",
    'exclusive = ["priority", "type"]',
    "",
    "[policy]",
    "close_requires_human = false",
    "mcp_can_close = true",
    "",
    "[commit]",
    '# subject = "docs(issues): {action} {title}"',
    "",
  ].join("\n");
}

/**
 * `issues init`: writes the starter config unless the log has one, and each chosen built-in
 * template (default `task`) to `<root>/templates/<name>.md`, never overwriting a file; reports
 * what it wrote and kept. A `--root` other than `docs/issues` gets a repo-level `issues.toml`
 * naming it, as adr's init does, so later commands find the log. No events are written. With
 * `commit`, commits only what it wrote.
 */
export async function initIssueLog(
  log: IssueLog,
  o: {
    readonly templates?: readonly string[];
    readonly commit?: boolean;
    readonly message?: string | null;
  } = {},
): Promise<IssuesInitJson> {
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
  const commit = files.length > 0 && (o.commit ?? log.issues.autoCommit);
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
      renderCommitMessage(log.issues.commitSubject, {
        title: INIT_TITLE,
        vars: { action: ACTIONS.init, id: "", display: "", command: "init" },
      }).message;
    sha = await commitWithRecovery(log.git, { message, only: written, rerun: INIT_RERUN });
  }
  return { format: "issues-init/v1", root, config, written, kept, skill: null, commit: sha, notes };
}
