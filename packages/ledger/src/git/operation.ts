import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Git operations: the lifetime of the caches that let one ledger read or write ask git less. A
 * git operation is unrelated to a subject's scope (`applies_to`).
 *
 * Inside an operation, `Git` methods on any instance share memoized answers that depend only on
 * refs and objects, and long-lived git processes. The operation is split into generations: every
 * git command that can change HEAD, a ref or the index ends the current one, which drops every
 * memoized value and shuts the long-lived processes down.
 */

/** What `Git.run` spawns: two `Git`s share a cache entry exactly when their spawns would match. */
export interface SpawnSpec {
  readonly binary: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The cache key of a spawn spec. */
export function specKey(spec: SpawnSpec): string {
  const env = Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([spec.binary, spec.cwd, spec.argv, env]);
}

/** A long-lived git process an operation holds for one generation. */
export interface Resident {
  /** Ends its input; the process answers what it already read, then exits. Idempotent. */
  end(): void;
  /** Settles once the process has exited (or failed to spawn). Never rejects. */
  readonly exited: Promise<void>;
}

const storage = new AsyncLocalStorage<GitOperation>();

/** One git operation: a generation number, its memo map and its long-lived processes. */
export class GitOperation {
  closed = false;
  generation = 0;
  #memo = new Map<string, Promise<unknown>>();
  #residents = new Map<string, Resident>();
  #failed = new Set<string>();
  readonly #closing = new Set<Resident>();

  /** The current generation's long-lived processes. Internal, for tests. */
  get residentCount(): number {
    return this.#residents.size;
  }

  /** Drops every memoized value and shuts the long-lived processes down. */
  endGeneration(): void {
    this.generation++;
    this.#memo = new Map();
    this.#failed = new Set();
    const residents = [...this.#residents.values()];
    this.#residents.clear();
    for (const r of residents) this.#retire(r);
  }

  /** The value `compute` gave in this generation, or a new one; a rejection isn't kept. */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const memo = this.#memo;
    const found = memo.get(key);
    if (found !== undefined) return found as Promise<T>;
    const pending = compute();
    memo.set(key, pending);
    pending.catch(() => {
      if (memo.get(key) === pending) memo.delete(key);
    });
    return pending;
  }

  /** This generation's process for `key`, started with `start` if needed; `null` once it failed. */
  resident<R extends Resident>(key: string, start: () => R): R | null {
    if (this.#failed.has(key)) return null;
    const found = this.#residents.get(key);
    if (found !== undefined) return found as R;
    const r = start();
    this.#residents.set(key, r);
    return r;
  }

  /** Marks `key` failed for this generation, when `r` is still its current process. */
  residentFailed(key: string, r: Resident): void {
    if (this.#residents.get(key) !== r) return; // an older generation's process: already retired
    this.#residents.delete(key);
    this.#failed.add(key);
    this.#retire(r);
  }

  /** Ends the operation and waits until every process it started has exited. Never throws. */
  async close(): Promise<void> {
    this.closed = true;
    this.endGeneration();
    while (this.#closing.size > 0) {
      await Promise.all([...this.#closing].map((r) => r.exited));
    }
  }

  #retire(r: Resident): void {
    this.#closing.add(r);
    r.end();
    void r.exited.then(() => this.#closing.delete(r));
  }
}

/** Runs `fn` as one git operation; inside an active operation it joins that one. */
export async function withGitOperation<T>(fn: () => Promise<T>): Promise<T> {
  return currentGitOperation() !== null ? fn() : withNewGitOperation(fn);
}

/** Runs `fn` in a new git operation, even inside an active one (MCP requests). Internal. */
export async function withNewGitOperation<T>(fn: () => Promise<T>): Promise<T> {
  const op = new GitOperation();
  try {
    return await storage.run(op, fn);
  } finally {
    await op.close();
  }
}

/** Ends the current operation's generation; a no-op outside an operation. */
export function invalidateGitOperation(): void {
  currentGitOperation()?.endGeneration();
}

/** The active, open operation of this async context, or `null`. Internal. */
export function currentGitOperation(): GitOperation | null {
  const s = storage.getStore();
  return s === undefined || s.closed ? null : s;
}

const READ_ONLY = new Set([
  "rev-parse",
  "cat-file",
  "ls-tree",
  "ls-files",
  "log",
  "rev-list",
  "diff",
  "merge-base",
  "show",
  "grep",
  "var",
  "version",
  "for-each-ref",
  "show-ref",
]);

const SYMBOLIC_REF_READ_FLAGS = new Set([
  "-q",
  "--quiet",
  "--short",
  "--no-recurse",
  "--end-of-options",
]);

/**
 * Whether a `Git.run` argument list can't change HEAD, a ref or the index. Unknown commands count
 * as changing them: a wrong "mutating" costs one cache drop, a wrong "read-only" a stale answer.
 * Internal.
 */
export function isReadOnlyGitCommand(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === "-c") i += 2;
    else if (
      a === "--literal-pathspecs" ||
      a === "--no-pager" ||
      a === "--no-optional-locks" ||
      a.startsWith("--git-dir=") ||
      a.startsWith("--work-tree=")
    )
      i++;
    else break;
  }
  const command = args[i];
  if (command === undefined) return false;
  const rest = args.slice(i + 1);
  if (READ_ONLY.has(command)) return true;
  switch (command) {
    case "remote":
      return rest.every((a) => a === "-v" || a === "--verbose");
    case "interpret-trailers":
      return !rest.includes("--in-place");
    case "hash-object":
      return !rest.includes("-w");
    case "symbolic-ref": {
      if (rest.includes("-d") || rest.includes("--delete")) return false;
      return rest.filter((a) => !SYMBOLIC_REF_READ_FLAGS.has(a)).length === 1;
    }
    default:
      return false;
  }
}
