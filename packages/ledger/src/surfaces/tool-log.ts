import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type CompiledKind, compileKind } from "../envelope/kind.js";
import { ConfigError, InvalidArgumentError, UsageError } from "../errors.js";
import type { Severity } from "../findings/finding.js";
import { Git, type GitOptions, requireWorkTree } from "../git/git.js";
import { indexReader, refReader, type TreeReader, worktreeReader } from "../git/tree.js";
import { type LogLayout, normalizeLayout } from "../identity/layout.js";
import type { AnyKind } from "../kind/types.js";
import { KEYWORD } from "../scope/anchors.js";
import { parseGlob } from "../scope/glob.js";
import { isTable, readToolConfig, type ToolConfig } from "../sources/config.js";
import { type CommitName, type CommitTemplate, readCommitTemplate } from "./commit-message.js";

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

/** Reads the keys of one tool config, with errors naming the file and key. */
export interface ToolConfigReader {
  readonly config: ToolConfig;
  /** The file errors name: the given path, else the config's own, else `<tool>.toml`. */
  readonly where: string;
  /** A `ConfigError` `<where>: <message>`. */
  readonly fail: (message: string) => ConfigError;
  /** The table `[name]`, `{}` when it's missing; refuses anything but a table. */
  readonly table: (name: string) => Record<string, unknown>;
  /** `t[key]` as a boolean, else `fallback` when it's missing. */
  readonly bool: (
    t: Record<string, unknown>,
    section: string,
    key: string,
    fallback: boolean,
  ) => boolean;
  /** `t[key]` as one of `values`, else `fallback` when it's missing; the message lists `values` in order. */
  readonly oneOf: <T extends string>(
    t: Record<string, unknown>,
    section: string,
    key: string,
    values: readonly T[],
    fallback: T,
  ) => T;
}

/**
 * A reader of `config`, read from `file` (`null` when unknown): errors name `file`, else
 * `config.file`, else `<tool>.toml`. A tool builds one and reads both its own keys and the shared
 * ones (`parseSharedKeys`) with it.
 */
export function toolConfigReader(
  config: ToolConfig,
  file: string | null,
  tool: string,
): ToolConfigReader {
  const where = file ?? config.file ?? `${tool}.toml`;
  const fail = (message: string) => new ConfigError(`${where}: ${message}`, { file: where });
  return {
    config,
    where,
    fail,
    table: (name) => {
      const t = config.raw[name];
      if (t === undefined) return {};
      if (!isTable(t)) throw fail(`${name} must be a table`);
      return t;
    },
    bool: (t, section, key, fallback) => {
      const v = t[key];
      if (v === undefined) return fallback;
      if (typeof v !== "boolean") throw fail(`${section}.${key} must be true or false`);
      return v;
    },
    oneOf: (t, section, key, values, fallback) => {
      const v = t[key];
      if (v === undefined) return fallback;
      if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
        throw fail(
          `${section}.${key} must be ${values.map((x) => JSON.stringify(x)).join(" or ")}`,
        );
      }
      return v as typeof fallback;
    },
  };
}

/** `[log] main_branch` and `[log] index`, the keys a log's numbering depends on. */
export interface NumberingKeys {
  /** The ref numbers come from; `null` resolves it automatically. */
  readonly mainBranch: string | null;
  /** `committed` keeps a generated `<root>/index.md`, whose numbers a shallow clone reads. */
  readonly index: "none" | "committed";
}

/**
 * Validates `[log] main_branch` and `[log] index` of the `[log]` table `log`, ignoring its other
 * keys. `indexValues` is the order the `log.index` message lists the values in.
 */
export function parseNumberingKeys(
  log: Record<string, unknown>,
  fail: (message: string) => ConfigError,
  o: { readonly indexValues: readonly ("none" | "committed")[] },
): NumberingKeys {
  const main = log.main_branch;
  if (
    main !== undefined &&
    (typeof main !== "string" || main.trim() === "" || main.startsWith("-") || main.includes("\0"))
  ) {
    throw fail("log.main_branch must be a ref name that doesn't start with -");
  }
  const index = log.index;
  if (index !== undefined && index !== "none" && index !== "committed") {
    throw fail(`log.index must be ${o.indexValues.map((x) => JSON.stringify(x)).join(" or ")}`);
  }
  return {
    mainBranch: typeof main === "string" ? main : null,
    index: index === "committed" ? "committed" : "none",
  };
}

/** The keys every tool config has. */
export interface SharedKeys extends NumberingKeys {
  /** `[log] default_template`: the template a new subject gets without `--template`. */
  readonly defaultTemplate: string;
  /** `[policy] auto_commit`: commit writes without `--commit`. */
  readonly autoCommit: boolean;
  /** `[verify] fail_on`. */
  readonly failOn: Severity;
  /** `[scope] anchor_keyword`: the code-anchor keyword, `adr` in `// adr:<id>`. */
  readonly anchorKeyword: string;
  /** `[scope] anchor_exclude`: globs of files whose anchors are ignored. */
  readonly anchorExclude: readonly string[];
  /** `[hooks] scope_follow_renames`: what the pre-commit hook does with renames of covered files. */
  readonly scopeFollowRenames: "stage" | "warn" | "off";
  /** `[hooks] index`: whether the pre-commit hook only checks `index.md` or regenerates it. */
  readonly hookIndex: "check" | "stage";
  /** `[commit] subject`: the template of `--commit` subjects. */
  readonly commitSubject: CommitTemplate;
}

export interface SharedKeyOptions {
  /** The tool's defaults for the keys whose default differs between tools. */
  readonly defaults: {
    readonly defaultTemplate: string;
    readonly anchorKeyword: string;
    /** `readCommitTemplate`'s `vars`, `names` and `defaultSubject`. */
    readonly commit: {
      readonly vars: Readonly<Record<string, number>>;
      readonly names?: readonly CommitName[];
      readonly defaultSubject: string;
    };
  };
  /** The order the `log.index` message lists the values in (`parseNumberingKeys`). */
  readonly indexValues: readonly ("none" | "committed")[];
}

const TEMPLATE = /^[a-z][a-z0-9-]*$/;
const MAX_TEMPLATE_NAME = 64;
const MAX_ANCHOR_EXCLUDE = 100;

/**
 * Validates the keys every tool config has, with `reader`'s file name in errors: `[log]
 * default_template`, `main_branch` and `index`, `[policy] auto_commit`, `[verify] fail_on`,
 * `[scope] anchor_keyword` and `anchor_exclude`, `[hooks] scope_follow_renames` and `index`, and
 * `[commit] subject`. Missing keys get their defaults; the tool reads its own keys with the same
 * reader.
 */
export function parseSharedKeys(reader: ToolConfigReader, o: SharedKeyOptions): SharedKeys {
  const { fail, table, bool, oneOf } = reader;
  const log = table("log");
  const policy = table("policy");
  const verify = table("verify");
  const scope = table("scope");
  const hooks = table("hooks");
  const template = log.default_template;
  if (
    template !== undefined &&
    (typeof template !== "string" ||
      template.length > MAX_TEMPLATE_NAME ||
      !TEMPLATE.test(template))
  ) {
    throw fail(`log.default_template must be a template name matching ${TEMPLATE.source}`);
  }
  const numbering = parseNumberingKeys(log, fail, { indexValues: o.indexValues });
  const keyword = scope.anchor_keyword;
  if (keyword !== undefined && (typeof keyword !== "string" || !KEYWORD.test(keyword))) {
    throw fail(`scope.anchor_keyword must match ${KEYWORD.source}`);
  }
  const exclude = scope.anchor_exclude;
  if (exclude !== undefined) {
    if (!Array.isArray(exclude) || exclude.length > MAX_ANCHOR_EXCLUDE) {
      throw fail(`scope.anchor_exclude must be an array of at most ${MAX_ANCHOR_EXCLUDE} globs`);
    }
    exclude.forEach((g: unknown, i) => {
      if (typeof g !== "string") throw fail(`scope.anchor_exclude[${i}] must be a string`);
      const parsed = parseGlob(g);
      if (!parsed.ok) throw fail(`scope.anchor_exclude[${i}]: ${parsed.message}`);
    });
  }
  return {
    defaultTemplate: typeof template === "string" ? template : o.defaults.defaultTemplate,
    ...numbering,
    autoCommit: bool(policy, "policy", "auto_commit", false),
    failOn: oneOf(verify, "verify", "fail_on", ["error", "warning"] as const, "error"),
    anchorKeyword: typeof keyword === "string" ? keyword : o.defaults.anchorKeyword,
    anchorExclude: Array.isArray(exclude) ? (exclude as string[]) : [],
    scopeFollowRenames: oneOf(
      hooks,
      "hooks",
      "scope_follow_renames",
      ["stage", "warn", "off"] as const,
      "stage",
    ),
    hookIndex: oneOf(hooks, "hooks", "index", ["check", "stage"] as const, "check"),
    commitSubject: readCommitTemplate(reader.config, {
      file: reader.where,
      vars: o.defaults.commit.vars,
      defaultSubject: o.defaults.commit.defaultSubject,
      ...(o.defaults.commit.names === undefined ? {} : { names: o.defaults.commit.names }),
    }),
  };
}
