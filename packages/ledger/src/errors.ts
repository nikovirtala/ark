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
  | "ulid-overflow";

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
