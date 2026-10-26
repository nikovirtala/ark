/**
 * Every error ledger throws. Wrong data in a repository is never thrown: it becomes a `Finding`.
 * A `LedgerError` means caller misuse, invalid config or an environment failure.
 *
 * All classes live in this one module so both package entries share a single definition and
 * `instanceof` works across them.
 */

export type LedgerErrorCode =
  | "invalid-argument"
  | "config"
  | "verify-usage"
  | "ref-not-found"
  | "git-not-found"
  | "not-a-repository"
  | "git-version"
  | "git-failed"
  | "git-timeout"
  | "event-exists"
  | "kind-definition"
  | "source-fetch"
  | "hook-shim"
  | "ulid-overflow"
  | "usage"
  | "file-exists"
  | "file-changed"
  | "hook-conflict"
  | "commit-failed";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

export class LedgerError extends Error {
  override name = "LedgerError";
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Caller misuse: a bad ref or path string, a bad trailer, a worktree-only call on a bare `Git`, … */
export class InvalidArgumentError extends LedgerError {
  override name = "InvalidArgumentError";

  constructor(message: string, options?: ErrorOptions) {
    super("invalid-argument", message, options);
  }
}

export class ConfigError extends LedgerError {
  override name = "ConfigError";
  readonly file: string | null;
  readonly line: number | null;

  constructor(
    message: string,
    where: { readonly file?: string | null; readonly line?: number | null } = {},
    options?: ErrorOptions,
  ) {
    super("config", message, options);
    this.file = where.file ?? null;
    this.line = where.line ?? null;
  }
}

export class VerifyUsageError extends LedgerError {
  override name = "VerifyUsageError";

  constructor(message: string, options?: ErrorOptions) {
    super("verify-usage", message, options);
  }
}

/** Bad command-line usage or an argument that names nothing; surfaces map it to exit 2. */
export class UsageError extends LedgerError {
  override name = "UsageError";

  constructor(message: string, options?: ErrorOptions) {
    super("usage", message, options);
  }
}

export class RefNotFoundError extends LedgerError {
  override name = "RefNotFoundError";
  readonly ref: string;

  constructor(ref: string, options?: ErrorOptions) {
    super("ref-not-found", `ref not found: ${ref}`, options);
    this.ref = ref;
  }
}

export class GitNotFoundError extends LedgerError {
  override name = "GitNotFoundError";
  readonly binary: string;

  constructor(binary: string, options?: ErrorOptions) {
    super("git-not-found", `git binary not found: ${binary}`, options);
    this.binary = binary;
  }
}

export class NotARepositoryError extends LedgerError {
  override name = "NotARepositoryError";
  readonly cwd: string;

  constructor(cwd: string, message = `not a git repository with a work tree: ${cwd}`) {
    super("not-a-repository", message);
    this.cwd = cwd;
  }
}

export class GitVersionError extends LedgerError {
  override name = "GitVersionError";
  readonly found: string;
  readonly required = "2.32.0" as const;

  constructor(found: string) {
    super("git-version", `git ${found} is too old; ledger needs git 2.32.0 or newer`);
    this.found = found;
  }
}

export class GitError extends LedgerError {
  override name = "GitError";
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    details: {
      readonly code?: "git-failed" | "git-timeout";
      readonly args: readonly string[];
      readonly exitCode: number | null;
      readonly stderr: string;
    },
    options?: ErrorOptions,
  ) {
    super(details.code ?? "git-failed", message, options);
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
  }
}

export class EventExistsError extends LedgerError {
  override name = "EventExistsError";
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super("event-exists", `event file already exists: ${path}`, options);
    this.path = path;
  }
}

/** A file that must be new already exists (bodies, copied templates). */
export class FileExistsError extends LedgerError {
  override name = "FileExistsError";
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super("file-exists", `file already exists: ${path}`, options);
    this.path = path;
  }
}

/** A file to replace no longer holds the bytes it was read with (or is gone). */
export class FileChangedError extends LedgerError {
  override name = "FileChangedError";
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super("file-changed", `${path} changed since it was read; run the command again`, options);
    this.path = path;
  }
}

export class KindDefinitionError extends LedgerError {
  override name = "KindDefinitionError";
  readonly kind: string;

  constructor(kind: string, message: string, options?: ErrorOptions) {
    super("kind-definition", message, options);
    this.kind = kind;
  }
}

export class SourceFetchError extends LedgerError {
  override name = "SourceFetchError";
  readonly source: string;
  readonly stderr: string;

  constructor(source: string, message: string, stderr = "", options?: ErrorOptions) {
    super("source-fetch", message, options);
    this.source = source;
    this.stderr = stderr;
  }
}

export class HookShimError extends LedgerError {
  override name = "HookShimError";
  readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super("hook-shim", message, options);
    this.path = path;
  }
}

/**
 * The shape of an install result `HookConflictError` carries; `HookInstallResult` (hooks/install.ts)
 * is assignable to it. Declared here so this module imports nothing.
 */
export interface HookConflictResult {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly conflicts: readonly {
    readonly hook: string;
    readonly path: string;
    readonly reason: "foreign-hook" | "hooks-path";
    readonly argv: readonly string[];
  }[];
}

/** `installHooks` met `core.hooksPath` or a foreign hook; the message says what to do for each. */
export class HookConflictError extends LedgerError {
  override name = "HookConflictError";
  readonly result: HookConflictResult;

  constructor(message: string, result: HookConflictResult, options?: ErrorOptions) {
    super("hook-conflict", message, options);
    this.result = result;
  }
}

/**
 * How to finish a commit git refused (`saveCommitRecovery` in surfaces/commit-recovery.ts builds
 * it). Declared here so this module imports nothing.
 */
export interface CommitRecovery {
  /** The commit's `only` paths, sorted. */
  readonly staged: readonly string[];
  /** Absolute path of the saved message, trailers included. */
  readonly messageFile: string;
  /** The sh command that makes the commit by hand. */
  readonly command: string;
  readonly trailers: readonly (readonly [string, string])[];
}

/** What `CommitFailedError` is built from. */
export interface CommitFailedInput {
  readonly recovery: CommitRecovery;
  /** First line: "git commit failed (exit 1): <first stderr line>", or what failed before the commit. */
  readonly headline: string;
  /** Indented under the headline (git's stderr, at most 40 lines); "" for none. */
  readonly detail: string;
  /** The caller's sentence on what running the command again would do. */
  readonly rerun: string;
  /** An extra step before the commit command; null for none. */
  readonly before: string | null;
  /** A step after the commit command and the trailer lines; null for none. */
  readonly after: string | null;
  /**
   * The command's own notes up to the failure (a write's notes, say): `runCli` prints them as
   * warnings before the error and puts them in the error document's `notes`. Default none.
   */
  readonly notes?: readonly string[];
}

/**
 * `git commit` failed after a tool wrote and staged its files: the message says what failed,
 * what is staged, and the exact command that finishes the commit with the saved message.
 */
export class CommitFailedError extends LedgerError {
  override name = "CommitFailedError";
  readonly recovery: CommitRecovery;
  readonly rerun: string;
  /** The command's notes, which the hint doesn't repeat; see `CommitFailedInput.notes`. */
  readonly notes: readonly string[];
  readonly #input: CommitFailedInput;

  constructor(o: CommitFailedInput, options?: ErrorOptions) {
    const { recovery } = o;
    const lines = [
      o.headline,
      ...(o.detail === "" ? [] : [o.detail]),
      `The files are written and staged. ${o.rerun} Staged for this commit:`,
      ...recovery.staged.map((p) => `  ${p}`),
      ...(o.before === null ? [] : [o.before]),
      `${o.before === null ? "Fix what made git fail, then commit" : "Then commit"} exactly these files with the message adr prepared:`,
      `  ${recovery.command}`,
      ...(recovery.trailers.length === 0
        ? ["The message has no trailers."]
        : [
            "The message ends with these trailers; keep them if you edit the file:",
            ...recovery.trailers.map(([k, v]) => `  ${k}: ${v}`),
          ]),
      ...(o.after === null ? [] : [o.after]),
    ];
    super("commit-failed", lines.join("\n"), options);
    this.recovery = recovery;
    this.rerun = o.rerun;
    this.notes = o.notes ?? [];
    this.#input = o;
  }

  /**
   * The same error with `notes` before its own: a caller further up adds the notes it made before
   * the step that failed, so they keep the order a successful run reports them in.
   */
  withNotes(notes: readonly string[]): CommitFailedError {
    if (notes.length === 0) return this;
    const input = { ...this.#input, notes: [...notes, ...this.notes] };
    return new CommitFailedError(input, this.cause === undefined ? {} : { cause: this.cause });
  }
}
