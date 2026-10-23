import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type CompiledKind, compileKind } from "../envelope/kind.js";
import { ConfigError, InvalidArgumentError, UsageError } from "../errors.js";
import { Git, type GitOptions, requireWorkTree } from "../git/git.js";
import { indexReader, refReader, type TreeReader, worktreeReader } from "../git/tree.js";
import { type LogLayout, normalizeLayout } from "../identity/layout.js";
import type { AnyKind } from "../kind/types.js";
import { readToolConfig, type ToolConfig } from "../sources/config.js";

export interface ToolLogOptions {
  readonly cwd: string;
  /** The tool's name; its config file is `<tool>.toml`. */
  readonly tool: string;
  readonly kind: AnyKind;
  /** `--root` as given, resolved against `cwd`. */
  readonly root?: string | null;
  /** `--ref`; `null` reads the work tree (or the index). */
  readonly ref?: string | null;
  /** Default `"worktree"`; ignored with `ref`. */
  readonly reader?: "worktree" | "index";
  readonly gitOptions?: GitOptions;
}

export interface ToolLog {
  readonly git: Git;
  readonly kind: AnyKind;
  readonly compiled: CompiledKind;
  readonly layout: LogLayout;
  /** The tree the config and the log are read from. */
  readonly tree: TreeReader;
  readonly ref: string | null;
  /** The commit `ref` resolves to, else `HEAD`'s (`null` when unborn). */
  readonly commit: string | null;
  readonly config: ToolConfig | null;
  readonly configPath: string | null;
  /** Things the user should know about how the log was located (D3 rule 1 override). Never errors. */
  readonly notes: readonly string[];
}

const TOOL = /^[a-z][a-z0-9-]*$/;

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** The normalized `[log] root` of a config file, or `null` when it sets none. */
function configuredRoot(config: ToolConfig, path: string): string | null {
  const log = config.raw.log;
  if (log === undefined) return null;
  if (!isTable(log)) throw new ConfigError(`${path}: log must be a table`, { file: path });
  const root = log.root;
  if (root === undefined) return null;
  if (typeof root !== "string") {
    throw new ConfigError(`${path}: log.root must be a string`, { file: path });
  }
  try {
    return normalizeLayout({ root }).root;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new ConfigError(`${path}: log.root: ${e.message}`, { file: path }, { cause: e });
  }
}

/** `--root` as a normalized repo-relative directory inside the work tree. */
async function rootFlag(git: Git, cwd: string, root: string): Promise<string> {
  const top = requireWorkTree(git);
  const rel = relative(top, resolve(await realpath(cwd), root));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UsageError(`--root ${root} is outside the repository ${top}`);
  }
  try {
    return normalizeLayout({ root: rel.split(sep).join("/") }).root;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new UsageError(`--root ${root}: ${e.message}`, { cause: e });
  }
}

/**
 * Opens a tool's log (design D3). The config is `<repo>/<tool>.toml`, whose `[log] root` chooses
 * the root, or `<root>/<tool>.toml`; `--root` overrides a repo config naming another root, with a
 * note. Config and log are read from the same tree: the `ref`'s, the index or the work tree.
 */
export async function openToolLog(o: ToolLogOptions): Promise<ToolLog> {
  if (!TOOL.test(o.tool)) throw new InvalidArgumentError(`invalid tool name: ${o.tool}`);
  const git = await Git.open(o.cwd, o.gitOptions);
  const ref = o.ref ?? null;
  let tree: TreeReader;
  let commit: string | null;
  if (ref !== null) {
    tree = await refReader(git, ref);
    commit = tree.commit;
  } else {
    commit = await git.resolveCommit("HEAD");
    tree = o.reader === "index" ? await indexReader(git) : worktreeReader(git);
  }

  const file = `${o.tool}.toml`;
  const repoConfig = await readToolConfig(tree, file);
  const repoRoot =
    repoConfig === null
      ? null
      : (configuredRoot(repoConfig, file) ??
        normalizeLayout({ root: o.kind.def.defaultRoot }).root);
  const notes: string[] = [];
  let root: string;
  let useRepoConfig: boolean;
  if (o.root !== undefined && o.root !== null) {
    root = await rootFlag(git, o.cwd, o.root);
    useRepoConfig = repoRoot === root;
    if (repoRoot !== null && !useRepoConfig) {
      notes.push(`ignoring ${file} (its root is ${repoRoot}; --root is ${root})`);
    }
  } else {
    root = repoRoot ?? normalizeLayout({ root: o.kind.def.defaultRoot }).root;
    useRepoConfig = repoConfig !== null;
  }

  const rootFile = `${root}/${file}`;
  const rootConfig = await readToolConfig(tree, rootFile);
  if (useRepoConfig && rootConfig !== null) {
    throw new ConfigError(`two config files for ${root}: ${file} and ${rootFile}`, {
      file: rootFile,
    });
  }
  if (rootConfig !== null) {
    const named = configuredRoot(rootConfig, rootFile);
    if (named !== null && named !== root) {
      throw new ConfigError(`${rootFile}: log.root is ${named}, but the file is in ${root}`, {
        file: rootFile,
      });
    }
  }
  const config = useRepoConfig ? repoConfig : rootConfig;
  return {
    git,
    kind: o.kind,
    compiled: compileKind(o.kind),
    layout: o.kind.layoutAt(root),
    tree,
    ref,
    commit,
    config,
    configPath: config === null ? null : useRepoConfig ? file : rootFile,
    notes,
  };
}
