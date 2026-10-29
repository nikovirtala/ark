import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  GitError,
  GitNotFoundError,
  GitVersionError,
  InvalidArgumentError,
  NotARepositoryError,
} from "../errors.js";
import { currentGitOperation, isReadOnlyGitCommand, type SpawnSpec, specKey } from "./operation.js";
import { CatFileParser, CatFileProcess, type CatObject, ResidentGone } from "./resident.js";

export interface GitOptions {
  /** The git executable, default `"git"`. */
  readonly binary?: string;
  /** Merged over `process.env`; a key set to `undefined` is removed. */
  readonly env?: NodeJS.ProcessEnv;
}

export type Trailer = readonly [key: string, value: string];

/** The variables git uses to locate a repository, which a hook may export. */
export const GIT_LOCATING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
] as const;

/** Pass as (part of) `GitOptions.env` so a `Git` never sees an outer repository. */
export const GIT_ENV_ISOLATION: NodeJS.ProcessEnv = Object.freeze(
  Object.fromEntries(GIT_LOCATING_ENV.map((k) => [k, undefined])),
);

/** Output-format overrides only; signing, credentials, hooks and transport config still apply. */
const READ_SAFETY = [
  "-c",
  "core.quotepath=off",
  "-c",
  "log.showSignature=false",
  "-c",
  "color.ui=never",
  "-c",
  "diff.renames=false",
] as const;

const REQUIRED_VERSION = [2, 32, 0] as const;
const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]*$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RunOptions {
  readonly input?: string | Uint8Array;
  /** Exit codes that don't throw, default `[0]`. */
  readonly okCodes?: readonly number[];
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/** Throws `InvalidArgumentError` for a revision git could read as an option. */
export function assertRev(rev: string): void {
  if (rev === "" || rev.startsWith("-") || rev.includes("\0")) {
    throw new InvalidArgumentError(`invalid revision: ${JSON.stringify(rev)}`);
  }
}

/** Throws `InvalidArgumentError` for a path git could read as an option. */
export function assertPath(path: string): void {
  if (path.startsWith("-") || path.includes("\0")) {
    throw new InvalidArgumentError(`invalid path: ${JSON.stringify(path)}`);
  }
}

const isBlank = (line: string) => /^[ \t\r]*$/.test(line);
const isComment = (line: string) => line.startsWith("#");

/** Whether the last paragraph of `text` is only `#` comment and blank lines. */
function lastIsCommentsOnly(text: string): boolean {
  const paragraphs = text.split(/\n[ \t\r]*\n/);
  const last = paragraphs[paragraphs.length - 1] as string;
  return last.split("\n").every((line) => isComment(line) || isBlank(line));
}

/**
 * The text of `message` with `trailers`: `message.trimEnd()`, a blank line, then one `Key: value`
 * line per trailer. With no trailers, `message` unchanged. `merge` appends the trailers to the
 * last paragraph instead of after a blank line; `Git.commitMessage` decides it by asking git.
 */
export function commitMessageText(
  message: string,
  trailers: readonly Trailer[],
  o: { readonly merge?: boolean } = {},
): string {
  if (trailers.length === 0) return message;
  const text = message.trimEnd();
  const lines = trailers.map(([k, v]) => `${k}: ${v}`).join("\n");
  return `${text}${o.merge === true ? "\n" : "\n\n"}${lines}\n`;
}

/** Returns the work-tree root, or throws `InvalidArgumentError` for a git-directory-only handle. */
export function requireWorkTree(git: Git): string {
  if (git.root === null) throw new InvalidArgumentError("operation needs a work tree");
  return git.root;
}

function assertTrailers(trailers: readonly Trailer[]): void {
  for (const [key, value] of trailers) {
    if (!TRAILER_KEY.test(key)) {
      throw new InvalidArgumentError(`invalid trailer key: ${JSON.stringify(key)}`);
    }
    if (/[\r\n]/.test(value)) {
      throw new InvalidArgumentError(`trailer value for ${key} must be a single line`);
    }
  }
}

function mergeEnv(...envs: (NodeJS.ProcessEnv | undefined)[]): Record<string, string> {
  const merged: NodeJS.ProcessEnv = Object.assign({}, process.env, ...envs, {
    GIT_OPTIONAL_LOCKS: "0",
  });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) out[k] = v;
  return out;
}

interface SpawnResult extends RunResult {
  readonly timedOut: boolean;
}

function spawnGit(
  binary: string,
  argv: readonly string[],
  o: { cwd?: string; env: Record<string, string>; input?: string | Uint8Array; timeoutMs?: number },
): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, argv, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (o.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, o.timeoutMs);
    }
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    // A child that exits before reading all of its input closes the pipe; that's not our error.
    child.stdin.on("error", () => {});
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT" || e.code === "EACCES")
        reject(new GitNotFoundError(binary, { cause: e }));
      else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        stdout: new Uint8Array(Buffer.concat(out)),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.end(o.input ?? "");
  });
}

/** What `git.run(args)` spawns: binary, argv with the fixed prefix, cwd and merged environment. */
export function spawnSpec(git: Git, args: readonly string[], env?: NodeJS.ProcessEnv): SpawnSpec {
  return {
    binary: git.options.binary ?? "git",
    argv: [...(git.root === null ? [`--git-dir=${git.gitDir}`] : []), ...READ_SAFETY, ...args],
    cwd: git.root ?? git.gitDir,
    env: mergeEnv(git.options.env, env),
  };
}

/**
 * `compute()`, memoized by `name` for the current git operation generation and `git`'s spawn
 * spec; outside an operation, `compute()` each time. Internal.
 */
export function operationMemo<T>(git: Git, name: string, compute: () => Promise<T>): Promise<T> {
  const op = currentGitOperation();
  if (op === null) return compute();
  return op.memo(`${specKey(spawnSpec(git, []))}\0${name}`, compute);
}

/** Revs the resident `cat-file` answers exactly as `rev-parse --verify` does. */
const RESIDENT_REV = (rev: string): boolean =>
  !/[\r\n]/.test(rev) && !rev.startsWith("^") && !rev.includes("@{") && !rev.includes(":");

/**
 * Looks `specs` up with the current git operation's `cat-file --batch` for `git`'s spawn spec,
 * started on first use. `null` outside an operation, or when that process failed in this
 * generation (the caller then runs its one-shot command). Getting the process and writing to it
 * happen in one synchronous step, so the request never goes to a process that was already ended.
 */
function residentCatFile(git: Git, specs: readonly string[]): Promise<(CatObject | null)[] | null> {
  const op = currentGitOperation();
  if (op === null) return Promise.resolve(null);
  const key = `cat-file\0${specKey(spawnSpec(git, []))}`;
  const r = op.resident(key, () => CatFileProcess.start(spawnSpec(git, ["cat-file", "--batch"])));
  if (r === null) return Promise.resolve(null);
  return r.read(specs).catch((e: unknown) => {
    if (!(e instanceof ResidentGone)) throw e;
    op.residentFailed(key, r);
    return null;
  });
}

const versionCache = new Map<string, Promise<void>>();

/** Runs `git version` once per binary; the promise is shared and evicted when it rejects. */
function ensureVersion(binary: string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  let pending = versionCache.get(binary);
  if (pending === undefined) {
    pending = spawnGit(binary, ["version"], { env: mergeEnv(env) }).then((r) => {
      const text = Buffer.from(r.stdout).toString("utf8").trim();
      const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
      if (r.code !== 0 || m === null) throw new GitVersionError(text || "unknown");
      const found = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
      for (let i = 0; i < 3; i++) {
        const a = found[i] ?? 0;
        const b = REQUIRED_VERSION[i] ?? 0;
        if (a !== b) {
          if (a < b) throw new GitVersionError(found.join("."));
          break;
        }
      }
    });
    versionCache.set(binary, pending);
    const settled = pending;
    settled.catch(() => {
      if (versionCache.get(binary) === settled) versionCache.delete(binary);
    });
  }
  return pending;
}

async function assertDirectory(path: string): Promise<void> {
  const s = await stat(path).catch(() => null);
  if (s === null || !s.isDirectory()) throw new NotARepositoryError(path);
}

function lines(bytes: Uint8Array): string[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "");
}

/** `Name <email> <time> <zone>` from `git var`, or `null`. */
function parseIdent(line: string | undefined): { name: string; email: string } | null {
  const m = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(line ?? "");
  return m === null ? null : { name: m[1] ?? "", email: m[2] ?? "" };
}

/** The paths of a `-z` listing, sorted. */
function zPaths(bytes: Uint8Array): string[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "")
    .sort();
}

/**
 * A handle on one repository. All git I/O goes through the user's git binary, so their config,
 * credentials and signing apply.
 */
export class Git {
  /** As passed, so derived instances inherit `binary` and `env`. */
  readonly options: GitOptions;
  /** Absolute work-tree top for `Git.open`; always `null` for `openGitDir` and `initBare`. */
  readonly root: string | null;
  readonly gitDir: string;
  readonly commonDir: string;

  private constructor(options: GitOptions, root: string | null, gitDir: string, commonDir: string) {
    this.options = options;
    this.root = root;
    this.gitDir = gitDir;
    this.commonDir = commonDir;
  }

  /** Opens the repository containing `cwd`. It must have a work tree. */
  static async open(cwd: string, opts: GitOptions = {}): Promise<Git> {
    const binary = opts.binary ?? "git";
    await ensureVersion(binary, opts.env);
    const dir = resolve(cwd);
    await assertDirectory(dir);
    const r = await spawnGit(
      binary,
      [
        ...READ_SAFETY,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd: dir, env: mergeEnv(opts.env) },
    );
    const [root, gitDir, commonDir] = lines(r.stdout);
    if (r.code !== 0 || root === undefined || gitDir === undefined || commonDir === undefined) {
      throw new NotARepositoryError(dir);
    }
    return new Git(opts, root, gitDir, commonDir);
  }

  /** A git-directory-only handle (bare or not): `root` is always `null`. */
  static async openGitDir(gitDir: string, opts: GitOptions = {}): Promise<Git> {
    const binary = opts.binary ?? "git";
    await ensureVersion(binary, opts.env);
    const dir = resolve(gitDir);
    await assertDirectory(dir);
    const r = await spawnGit(
      binary,
      [`--git-dir=${dir}`, ...READ_SAFETY, "rev-parse", "--absolute-git-dir", "--git-common-dir"],
      { cwd: dir, env: mergeEnv(opts.env) },
    );
    const [absGitDir, commonDir] = lines(r.stdout);
    if (r.code !== 0 || absGitDir === undefined || commonDir === undefined) {
      throw new NotARepositoryError(dir, `not a git directory: ${dir}`);
    }
    return new Git(opts, null, absGitDir, resolve(dir, commonDir));
  }

  /** Creates a bare repository at `dir` and opens it with `openGitDir`. */
  static async initBare(dir: string, opts: GitOptions = {}): Promise<Git> {
    const binary = opts.binary ?? "git";
    await ensureVersion(binary, opts.env);
    const abs = resolve(dir);
    await mkdir(dirname(abs), { recursive: true });
    const args = ["init", "--bare", "-q", "--", abs];
    const op = currentGitOperation();
    op?.endGeneration();
    let r: SpawnResult;
    try {
      r = await spawnGit(binary, args, { cwd: dirname(abs), env: mergeEnv(opts.env) });
    } finally {
      op?.endGeneration();
    }
    if (r.code !== 0) {
      throw new GitError(`git init failed: ${r.stderr.trim()}`, {
        args,
        exitCode: r.code,
        stderr: r.stderr,
      });
    }
    return Git.openGitDir(abs, opts);
  }

  /**
   * Runs git with the output-format overrides; throws `GitError` outside `okCodes`. Inside a git
   * operation, a command that can change HEAD, a ref or the index ends the operation's generation
   * before it starts and again when it finishes.
   */
  async run(args: readonly string[], o: RunOptions = {}): Promise<RunResult> {
    const op = currentGitOperation();
    if (op === null || isReadOnlyGitCommand(args)) return this.#run(args, o);
    op.endGeneration();
    try {
      return await this.#run(args, o);
    } finally {
      op.endGeneration();
    }
  }

  async #run(args: readonly string[], o: RunOptions): Promise<RunResult> {
    const spec = spawnSpec(this, args, o.env);
    const spawnOpts: Parameters<typeof spawnGit>[2] = { cwd: spec.cwd, env: { ...spec.env } };
    if (o.input !== undefined) spawnOpts.input = o.input;
    if (o.timeoutMs !== undefined) spawnOpts.timeoutMs = o.timeoutMs;
    const r = await spawnGit(spec.binary, spec.argv, spawnOpts);
    if (r.timedOut) {
      throw new GitError(`git ${args[0] ?? ""} timed out after ${o.timeoutMs} ms`, {
        code: "git-timeout",
        args,
        exitCode: null,
        stderr: r.stderr,
      });
    }
    if (!(o.okCodes ?? [0]).includes(r.code)) {
      const reason = r.stderr.trim().split("\n")[0] ?? "";
      throw new GitError(`git ${args[0] ?? ""} exited with ${r.code}: ${reason}`, {
        args,
        exitCode: r.code,
        stderr: r.stderr,
      });
    }
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  /** The commit `rev` names, or `null` when it doesn't resolve to one. */
  async resolveCommit(rev: string): Promise<string | null> {
    assertRev(rev);
    if (RESIDENT_REV(rev)) {
      const found = await residentCatFile(this, [`${rev}^{commit}`]);
      if (found !== null) return found[0]?.type === "commit" ? found[0].oid : null;
    }
    const r = await this.run(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
      { okCodes: [0, 1, 128] },
    );
    return r.code === 0 ? (lines(r.stdout)[0] ?? null) : null;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const [ca, cb] = await Promise.all([this.resolveCommit(a), this.resolveCommit(b)]);
    if (ca === null || cb === null) return null;
    const r = await this.run(["merge-base", "--end-of-options", ca, cb], { okCodes: [0, 1] });
    return r.code === 0 ? (lines(r.stdout)[0] ?? null) : null;
  }

  /** The ref a symbolic ref points to (`refs/remotes/origin/HEAD` → `refs/remotes/origin/main`), or `null`. */
  async symbolicRef(ref: string): Promise<string | null> {
    assertRev(ref);
    return operationMemo(this, `symbolic-ref\0${ref}`, async () => {
      const r = await this.run(["symbolic-ref", "-q", "--end-of-options", ref], {
        okCodes: [0, 1],
      });
      return r.code === 0 ? (lines(r.stdout)[0] ?? null) : null;
    });
  }

  async isShallow(): Promise<boolean> {
    return operationMemo(this, "is-shallow", async () => {
      const r = await this.run(["rev-parse", "--is-shallow-repository"]);
      return lines(r.stdout)[0] === "true";
    });
  }

  async objectFormat(): Promise<"sha1" | "sha256"> {
    const r = await this.run(["rev-parse", "--show-object-format"]);
    return lines(r.stdout)[0] === "sha256" ? "sha256" : "sha1";
  }

  async add(paths: readonly string[]): Promise<void> {
    requireWorkTree(this);
    for (const p of paths) assertPath(p);
    if (paths.length === 0) return;
    await this.run(["--literal-pathspecs", "add", "--", ...paths]);
  }

  /**
   * The configured identity, `git -c user.useConfigOnly=true var GIT_AUTHOR_IDENT`: from the
   * `GIT_AUTHOR_*` variables or `user.name`/`user.email`, never guessed. `null` when there is none.
   */
  async identity(): Promise<{ name: string; email: string } | null> {
    const r = await this.run(["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"], {
      okCodes: [0, 128],
    });
    if (r.code !== 0) return null;
    return parseIdent(lines(r.stdout)[0]);
  }

  /**
   * The configured committer, `git -c user.useConfigOnly=true var GIT_COMMITTER_IDENT`: from the
   * `GIT_COMMITTER_*` variables or `user.name`/`user.email`, never guessed. `null` when there is
   * none, so a commit would fail.
   */
  async committerIdentity(): Promise<{ name: string; email: string } | null> {
    const r = await this.run(["-c", "user.useConfigOnly=true", "var", "GIT_COMMITTER_IDENT"], {
      okCodes: [0, 128],
    });
    if (r.code !== 0) return null;
    return parseIdent(lines(r.stdout)[0]);
  }

  /**
   * The exact text `Git.commit` sends for these options (see `commitMessageText`). With
   * `mergeTrailers` and trailers, the installed git is asked once whether it reads trailers in
   * the message's last paragraph (`git interpret-trailers --parse --no-divider`, with the user's
   * `trailer.*` and `core.commentChar` config, which also apply when git reads the commit); if it
   * does, the trailers are appended to that paragraph so git reads one block. A last paragraph of
   * only `#` comment lines is never merged into. Invalid trailers, and trailers with an empty
   * message, throw `InvalidArgumentError`; a failing `interpret-trailers` throws its `GitError`.
   */
  async commitMessage(o: {
    readonly message: string;
    readonly trailers?: readonly Trailer[];
    readonly mergeTrailers?: boolean;
  }): Promise<string> {
    const trailers = o.trailers ?? [];
    assertTrailers(trailers);
    if (trailers.length > 0 && o.message.trim() === "") {
      throw new InvalidArgumentError("a commit with trailers needs a message");
    }
    const text = o.message.trimEnd();
    const merge =
      o.mergeTrailers === true &&
      trailers.length > 0 &&
      !lastIsCommentsOnly(text) &&
      (await this.#readsTrailers(text));
    return commitMessageText(o.message, trailers, { merge });
  }

  /**
   * Whether git reads any trailers in the last paragraph of `text`. `--parse` includes
   * `--only-input`, so no configured trailer is added and no `trailer.<token>.cmd` runs.
   * `--no-divider`, since `git commit` doesn't treat `---` as the end of a commit message.
   */
  async #readsTrailers(text: string): Promise<boolean> {
    const r = await this.run(["interpret-trailers", "--parse", "--no-divider"], { input: text });
    return Buffer.from(r.stdout).toString("utf8").trim() !== "";
  }

  /**
   * Commits the index with `message` as given (`--cleanup=whitespace`); returns the new sha.
   *
   * `trailers` are written into the message as its last paragraph, in order, rather than through
   * `--trailer`, so the user's `trailer.*` config can't drop, merge or move them. A message whose
   * own last paragraph is a trailer block would end up with two blocks, and git reads only the
   * last one: pass every trailer through `trailers`, or set `mergeTrailers` to append them to
   * that block when the installed git reads trailers in it (see `commitMessage`). Trailers with
   * an empty message throw `InvalidArgumentError`, since they would become the subject.
   *
   * `only` commits just those paths (`git commit --only`, their work-tree content); other staged
   * changes stay staged.
   */
  async commit(o: {
    readonly message: string;
    readonly trailers?: readonly Trailer[];
    readonly mergeTrailers?: boolean;
    readonly allowEmpty?: boolean;
    readonly only?: readonly string[];
  }): Promise<string> {
    requireWorkTree(this);
    for (const p of o.only ?? []) assertPath(p);
    const message = await this.commitMessage(o);
    await this.run(
      [
        ...(o.only === undefined ? [] : ["--literal-pathspecs"]),
        "commit",
        "--file=-",
        "--cleanup=whitespace",
        ...(o.allowEmpty === true ? ["--allow-empty"] : []),
        ...(o.only === undefined ? [] : ["--only", "--", ...o.only]),
      ],
      { input: message },
    );
    const sha = await this.resolveCommit("HEAD");
    if (sha === null)
      throw new GitError("HEAD does not resolve after commit", {
        args: ["commit"],
        exitCode: null,
        stderr: "",
      });
    return sha;
  }

  /**
   * Paths under `pathspecs` staged as added or modified (`addedOnly`: added) against `HEAD`, or
   * against nothing on an unborn `HEAD`. Sorted; `[]` for empty `pathspecs`.
   */
  async stagedPaths(
    pathspecs: readonly string[],
    o: { readonly addedOnly?: boolean } = {},
  ): Promise<string[]> {
    requireWorkTree(this);
    for (const p of pathspecs) assertPath(p);
    if (pathspecs.length === 0) return [];
    const head = (await this.resolveCommit("HEAD")) === null ? [] : ["HEAD"];
    const r = await this.run([
      "--literal-pathspecs",
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      `--diff-filter=${o.addedOnly === true ? "A" : "AM"}`,
      "-z",
      ...head,
      "--",
      ...pathspecs,
    ]);
    return zPaths(r.stdout);
  }

  /** Paths under `pathspecs` whose work-tree content differs from the index. Sorted. */
  async unstagedPaths(pathspecs: readonly string[]): Promise<string[]> {
    requireWorkTree(this);
    for (const p of pathspecs) assertPath(p);
    if (pathspecs.length === 0) return [];
    const r = await this.run([
      "--literal-pathspecs",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "--",
      ...pathspecs,
    ]);
    return zPaths(r.stdout);
  }

  /**
   * Every tracked path of a tree, sorted: the index (`GIT_INDEX_FILE` honoured), the work tree
   * (the index minus files deleted from the work tree; untracked files aren't listed) or a commit.
   * Submodules are listed like files.
   */
  async trackedPaths(head: "worktree" | "index" | { readonly commit: string }): Promise<string[]> {
    if (typeof head === "object") {
      assertRev(head.commit);
      const r = await this.run(["ls-tree", "-r", "-z", "--name-only", "--full-tree", head.commit]);
      return zPaths(r.stdout);
    }
    requireWorkTree(this);
    // An unmerged path has an entry per stage.
    const cached = [...new Set(zPaths((await this.run(["ls-files", "-z", "--cached"])).stdout))];
    if (head === "index") return cached;
    const deleted = new Set(zPaths((await this.run(["ls-files", "-z", "--deleted"])).stdout));
    return cached.filter((p) => !deleted.has(p));
  }

  /**
   * The paths that differ between the commit `base` and `head`, sorted; a rename lists both its
   * paths. `base === null` (no base, such as an unborn `HEAD`) gives every tracked path of `head`.
   */
  async changedPaths(
    base: string | null,
    head: "worktree" | "index" | { readonly commit: string },
  ): Promise<string[]> {
    if (base === null) return this.trackedPaths(head);
    assertRev(base);
    if (typeof head === "object") assertRev(head.commit);
    else requireWorkTree(this);
    const r = await this.run([
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      ...(head === "index" ? ["--cached"] : []),
      base,
      ...(typeof head === "object" ? [head.commit] : []),
      "--",
    ]);
    return zPaths(r.stdout);
  }

  /** Untracked paths under `pathspecs`, ignored files included. Sorted; `[]` for empty `pathspecs`. */
  async untrackedPaths(pathspecs: readonly string[]): Promise<string[]> {
    requireWorkTree(this);
    for (const p of pathspecs) assertPath(p);
    if (pathspecs.length === 0) return [];
    const r = await this.run([
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "-z",
      "--",
      ...pathspecs,
    ]);
    return zPaths(r.stdout);
  }

  /**
   * Adds trailers to the end of a commit message file's trailer block (for `commit-msg`). By
   * default a trailer whose key and value are already present is skipped (`addIfDifferent`);
   * `ifExists: "add"` keeps repeats, such as `ADR: k` once per event of one decision in a commit.
   * The options override the user's `trailer.*` config.
   */
  async appendTrailers(
    messageFile: string,
    trailers: readonly Trailer[],
    o: { readonly ifExists?: "add" | "addIfDifferent" } = {},
  ): Promise<void> {
    assertPath(messageFile);
    assertTrailers(trailers);
    if (trailers.length === 0) return;
    await this.run([
      "interpret-trailers",
      "--in-place",
      "--if-exists",
      o.ifExists ?? "addIfDifferent",
      "--if-missing",
      "add",
      "--where",
      "end",
      ...trailers.flatMap(([k, v]) => ["--trailer", `${k}: ${v}`]),
      "--",
      resolve(messageFile),
    ]);
  }

  /** Reads blobs by oid with one `cat-file --batch`; missing objects are absent from the map. */
  async readBlobs(oids: readonly string[]): Promise<Map<string, Uint8Array>> {
    for (const oid of oids) {
      if (!OID.test(oid))
        throw new InvalidArgumentError(`invalid object id: ${JSON.stringify(oid)}`);
    }
    const unique = [...new Set(oids)];
    const objects = await catFileBatch(this, unique);
    const out = new Map<string, Uint8Array>();
    unique.forEach((oid, i) => {
      const obj = objects[i];
      if (obj?.type === "blob") out.set(oid, obj.bytes);
    });
    return out;
  }
}

/**
 * Looks `specs` (oids or `<rev>:<path>`) up with `cat-file --batch`, returning results in input
 * order: `null` for a missing object or a spec that can't be sent (contains a newline). Inside a
 * git operation the operation's resident `cat-file` answers; otherwise one `cat-file` runs.
 */
export async function catFileBatch(
  git: Git,
  specs: readonly string[],
): Promise<({ type: string; bytes: Uint8Array } | null)[]> {
  const sendable = specs.filter((s) => !/[\r\n]/.test(s));
  if (sendable.length === 0) return specs.map(() => null);
  const results = (await residentCatFile(git, sendable)) ?? (await oneShotCatFile(git, sendable));
  let next = 0;
  return specs.map((s) => {
    if (/[\r\n]/.test(s)) return null;
    const obj = results[next++] ?? null;
    return obj === null ? null : { type: obj.type, bytes: obj.bytes };
  });
}

/** One `cat-file --batch` process for `specs`; throws `GitError` when answers are missing. */
async function oneShotCatFile(git: Git, specs: readonly string[]): Promise<(CatObject | null)[]> {
  const r = await git.run(["cat-file", "--batch"], { input: `${specs.join("\n")}\n` });
  const parser = new CatFileParser();
  const results = [...parser.push(r.stdout), ...parser.end()];
  if (results.length < specs.length) {
    throw new GitError("truncated cat-file output", {
      args: ["cat-file", "--batch"],
      exitCode: r.code,
      stderr: r.stderr,
    });
  }
  return results.slice(0, specs.length);
}
