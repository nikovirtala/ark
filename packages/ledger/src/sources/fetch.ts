import { createHash, randomBytes } from "node:crypto";
import { type FileHandle, link, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { GitError, NotARepositoryError, SourceFetchError } from "../errors.js";
import { GIT_ENV_ISOLATION, Git, type GitOptions } from "../git/git.js";
import { refReader, type TreeReader } from "../git/tree.js";
import type { SourceConfig } from "./config.js";

/** A source's log as pinned in its local cache. */
export interface FetchedSource {
  readonly config: SourceConfig;
  /** The pinned commit. */
  readonly commit: string;
  /** The pinned commit's tree, read from the cache. */
  readonly tree: TreeReader;
  /**
   * The refetch failed and the previously pinned commit is served. `readSources` turns this into
   * an error in network mode, so a stale cache never passes for a fetched one.
   */
  readonly stale: boolean;
  /** The first line of git's stderr when `stale`, else `null`. */
  readonly staleReason: string | null;
  /** The cache's bare repository. */
  readonly cacheDir: string;
}

const PINNED = "refs/ark/pinned";
const METADATA = "ark-source.json";
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const POLL_MS = 100;
/** Time a lock holder gets beyond its fetch timeout for the local git steps around the fetch. */
const LOCK_GRACE_MS = 30_000;

/** The first non-empty line of git's stderr, or the error message when stderr is empty. */
function gitReason(e: GitError): string {
  const line = e.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? e.message;
}

/** A URL with no `://` and no scp-like `host:path` form names a local path. */
function isLocalUrl(url: string): boolean {
  return !url.includes("://") && !/^[^/]*:/.test(url);
}

type ObjectFormat = "sha1" | "sha256";

/** The format a full hex oid belongs to by its length, else `null`. */
function formatOfOid(oid: string): ObjectFormat | null {
  if (/^[0-9a-f]{40}$/.test(oid)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(oid)) return "sha256";
  return null;
}

/**
 * The source's object format from the oids `ls-remote` prints for `ref`, or `null` when it can't
 * be told: the command failed or timed out, no ref matched, or the first line isn't `<oid>\t<ref>`.
 */
async function remoteFormat(
  cache: Git,
  url: string,
  ref: string,
  timeoutMs: number,
): Promise<ObjectFormat | null> {
  try {
    const r = await cache.run(["-c", "protocol.ext.allow=never", "ls-remote", "--", url, ref], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs,
    });
    const first = Buffer.from(r.stdout).toString("utf8").split("\n")[0] ?? "";
    return formatOfOid(first.split("\t")[0] ?? "");
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

async function pinnedCommit(cache: Git): Promise<string | null> {
  return cache.resolveCommit(PINNED);
}

async function isDirectory(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null);
  return s?.isDirectory() === true;
}

/** A lock file's content and identity, read through one handle so both describe the same file. */
interface LockFile {
  readonly raw: string;
  readonly mtimeMs: number;
  readonly ino: number;
}

/** The lock file at `path`, or `null` when there is none. */
async function readLock(path: string): Promise<LockFile | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const s = await handle.stat();
    const raw = await handle.readFile("utf8");
    return { raw, mtimeMs: s.mtimeMs, ino: s.ino };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface LockRecord {
  readonly pid?: unknown;
  readonly hostname?: unknown;
  readonly expiresAt?: unknown;
}

function parseRecord(raw: string): LockRecord | null {
  try {
    return JSON.parse(raw) as LockRecord | null;
  } catch {
    return null;
  }
}

function sameLock(a: LockFile, b: LockFile): boolean {
  return a.raw === b.raw && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/** @internal Injectable process, clock and interleaving hooks for `acquireLock`'s tests. */
export interface LockDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly kill: (pid: number, signal: 0) => void;
  readonly hostname: () => string;
  readonly pid: number;
  /** Runs after a lock is judged stale, before it is renamed aside. Test seam only. */
  readonly beforeReclaim?: (lockPath: string) => Promise<void>;
  /** Runs after a renamed lock turned out not to be the judged one, before it is put back. */
  readonly beforeRestore?: (lockPath: string) => Promise<void>;
}

const defaultLockDeps: LockDeps = {
  now: Date.now,
  sleep: (ms) => sleep(ms),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  hostname,
  pid: process.pid,
};

/**
 * Whether a lock was left behind by a process that is gone. A holder records when its own time
 * budget runs out (`expiresAt`), so a caller with a shorter timeout can't take a live lock over;
 * a holder on this host whose pid no longer exists (`kill(pid, 0)` fails with ESRCH) is dead
 * already. EPERM means the process exists under another user. This assumes one pid namespace per
 * hostname: containers sharing both the cache directory and the hostname could misjudge a live
 * holder as dead. A reused pid makes a dead holder look alive until `expiresAt`, the safe side.
 * A lock without a readable record (a holder between creating and writing it, or a crash in
 * between) is judged only on arrival, by its age against the caller's own timeout, so a waiter
 * never takes over a lock it saw being taken.
 */
function lockStatus(
  lock: LockFile,
  o: { readonly arrival: boolean; readonly timeoutMs: number; readonly deps: LockDeps },
): "live" | "stale" {
  const record = parseRecord(lock.raw);
  if (typeof record?.expiresAt === "number") {
    if (o.deps.now() > record.expiresAt) return "stale";
    const { pid } = record;
    if (
      typeof record.hostname === "string" &&
      record.hostname === o.deps.hostname() &&
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0
    ) {
      try {
        o.deps.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return "stale";
      }
    }
    return "live";
  }
  return o.arrival && o.deps.now() - lock.mtimeMs > o.timeoutMs ? "stale" : "live";
}

/**
 * Removes the stale lock `judged` without ever removing a live one: the lock is renamed aside
 * atomically, so of several reclaimers exactly one gets it, and deleted only if the moved file is
 * still the one judged (content, inode and mtime). Otherwise another caller created a fresh lock
 * after the inspection, and it is linked back, which fails rather than overwrite a newer lock.
 *
 * Remaining window: if a third caller creates a lock in the moment between the rename and the
 * link back, the link fails, and the moved lock's holder and that caller both believe they hold
 * the lock. Concurrent fetches into one bare repository then surface as a `GitError` from git's
 * own ref locks, not as corruption. The `rename` fallback for filesystems without hard links has
 * the same window. A crash between the rename and the removal leaves a `<lock>.stale-*` file that
 * nothing reads.
 */
async function reclaim(
  lockPath: string,
  judged: LockFile,
  source: string,
  deps: LockDeps,
): Promise<"removed" | "gone" | "restored"> {
  await deps.beforeReclaim?.(lockPath);
  const aside = `${lockPath}.stale-${deps.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(lockPath, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw new SourceFetchError(source, `cannot reclaim source cache lock: ${lockPath}`, "", {
      cause: e,
    });
  }
  const moved = await readLock(aside);
  if (moved !== null && sameLock(moved, judged)) {
    await rm(aside, { force: true });
    return "removed";
  }
  await deps.beforeRestore?.(lockPath);
  try {
    await link(aside, lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      await rename(aside, lockPath).catch(() => {});
    }
  }
  await rm(aside, { force: true });
  return "restored";
}

/**
 * @internal Takes the lock at `lockPath`, waiting up to `timeoutMs` for its holder, and returns
 * the function that releases it. Every poll judges the current lock again, so a lock whose holder
 * died or ran out of budget is reclaimed as soon as that is noticed.
 */
export async function acquireLock(
  lockPath: string,
  source: string,
  timeoutMs: number,
  overrides: Partial<LockDeps> = {},
): Promise<() => Promise<void>> {
  const deps: LockDeps = { ...defaultLockDeps, ...overrides };
  const deadline = deps.now() + timeoutMs;
  let arrival = true;
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new SourceFetchError(source, `cannot create source cache lock: ${lockPath}`, "", {
          cause: e,
        });
      }
      const lock = await readLock(lockPath);
      if (lock !== null && lockStatus(lock, { arrival, timeoutMs, deps }) === "stale") {
        arrival = false;
        // Removed by us or by another reclaimer: retry the create right away. A lock that was
        // put back is judged again on the next poll.
        if ((await reclaim(lockPath, lock, source, deps)) !== "restored") continue;
      }
      arrival = false;
      if (deps.now() >= deadline) {
        throw new SourceFetchError(
          source,
          `source cache is locked by another process: ${lockPath}`,
        );
      }
      await deps.sleep(POLL_MS);
      continue;
    }
    const own = JSON.stringify({
      pid: deps.pid,
      hostname: deps.hostname(),
      token: randomBytes(8).toString("hex"),
      expiresAt: deps.now() + timeoutMs + LOCK_GRACE_MS,
    });
    try {
      await handle.writeFile(own);
      await handle.close();
    } catch (e) {
      await handle.close().catch(() => {});
      await rm(lockPath, { force: true });
      throw new SourceFetchError(source, `cannot write source cache lock: ${lockPath}`, "", {
        cause: e,
      });
    }
    return async () => {
      // Another process may have reclaimed the lock in the meantime; leave its lock alone.
      if ((await readLock(lockPath))?.raw === own) await rm(lockPath, { force: true });
    };
  }
}

async function writeMetadata(cacheDir: string, data: Record<string, string>): Promise<void> {
  const target = join(cacheDir, METADATA);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, target);
}

/**
 * Fetches `s` into its own bare cache repository under `<commonDir>/ark/sources/` (never into the
 * calling repository, which a `--depth=1` fetch would make shallow) and pins the result. When the
 * fetch fails but the cache already pins a commit, that commit is served with `stale: true`.
 * Throws `SourceFetchError` when there is nothing to serve. The cache uses the source's object
 * format: a full-sha ref's by its length; for a named ref, a failed fetch asks the source with
 * `ls-remote`, and a cache of the other format is recreated.
 */
export async function fetchSource(
  git: Git,
  s: SourceConfig,
  o: { readonly offline?: boolean; readonly timeoutMs?: number } = {},
): Promise<FetchedSource> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  const url = isLocalUrl(s.url) ? resolve(git.root ?? git.gitDir, s.url) : s.url;
  const key = createHash("sha256").update(`${url}\0${s.ref}`).digest("hex").slice(0, 12);
  const sourcesDir = join(git.commonDir, "ark", "sources");
  const cacheDir = join(sourcesDir, `${s.name}-${key}.git`);
  const cacheOpts: GitOptions = {
    ...git.options,
    env: { ...git.options.env, ...GIT_ENV_ISOLATION },
  };
  const served = async (cache: Git, staleReason: string | null): Promise<FetchedSource> => {
    const tree = await refReader(cache, PINNED);
    const stale = staleReason !== null;
    return { config: s, commit: tree.commit ?? "", tree, stale, staleReason, cacheDir };
  };

  if (o.offline === true) {
    const cache = (await isDirectory(cacheDir))
      ? await Git.openGitDir(cacheDir, cacheOpts).catch(() => null)
      : null;
    const commit = cache === null ? null : await pinnedCommit(cache);
    if (cache === null || commit === null) {
      throw new SourceFetchError(s.name, `source ${s.name} is not cached; fetch it online first`);
    }
    return served(cache, null);
  }

  try {
    await mkdir(dirname(cacheDir), { recursive: true });
  } catch (e) {
    throw new SourceFetchError(s.name, `cannot create source cache directory: ${sourcesDir}`, "", {
      cause: e,
    });
  }
  const release = await acquireLock(`${cacheDir}.lock`, s.name, timeoutMs);
  try {
    const deadline = Date.now() + timeoutMs;
    const shaFormat = FULL_SHA.test(s.ref) ? formatOfOid(s.ref) : null;
    const recreate = async (format: ObjectFormat): Promise<Git> => {
      try {
        await rm(cacheDir, { recursive: true, force: true });
      } catch (e) {
        throw new SourceFetchError(s.name, `cannot recreate source cache: ${cacheDir}`, "", {
          cause: e,
        });
      }
      return Git.initBare(cacheDir, cacheOpts, { objectFormat: format });
    };
    const tryFetch = async (cache: Git, ms: number): Promise<GitError | null> => {
      try {
        await cache.run(
          ["-c", "protocol.ext.allow=never", "fetch", "--depth=1", "--no-tags", "--", url, s.ref],
          { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: ms },
        );
        return null;
      } catch (e) {
        if (e instanceof GitError) return e;
        throw e;
      }
    };
    const existing = (await isDirectory(cacheDir))
      ? await Git.openGitDir(cacheDir, cacheOpts).catch(async (e: unknown) => {
          if (!(e instanceof NotARepositoryError)) throw e;
          // Left behind by an interrupted `git init --bare` or emptied by hand: start over.
          await rm(cacheDir, { recursive: true, force: true });
          return null;
        })
      : null;
    let cache =
      existing ?? (await Git.initBare(cacheDir, cacheOpts, { objectFormat: shaFormat ?? "sha1" }));
    let pinned = existing === null ? null : await pinnedCommit(cache);
    if (shaFormat !== null && pinned === s.ref) return await served(cache, null);
    if (existing !== null && shaFormat !== null && (await cache.objectFormat()) !== shaFormat) {
      cache = await recreate(shaFormat);
      pinned = null;
    }
    let failure = await tryFetch(cache, timeoutMs);
    // A named ref doesn't say its format: a failed fetch may be a cache of the other format, so
    // ask the source, without parsing git's (translated) message. A timeout is never a mismatch.
    if (failure !== null && shaFormat === null && failure.code !== "git-timeout") {
      const left = deadline - Date.now();
      const remote = left < 1 ? null : await remoteFormat(cache, url, s.ref, left);
      if (remote !== null && remote !== (await cache.objectFormat())) {
        // The old cache can never fetch from this source again, nor is its pin worth serving.
        cache = await recreate(remote);
        pinned = null;
        const left2 = deadline - Date.now();
        if (left2 >= 1) failure = await tryFetch(cache, left2);
      }
    }
    if (failure !== null) {
      if (pinned !== null) return await served(cache, gitReason(failure));
      throw new SourceFetchError(
        s.name,
        `cannot fetch source ${s.name} (${s.ref}): ${gitReason(failure)}`,
        failure.stderr,
        { cause: failure },
      );
    }
    const commit = await cache.resolveCommit("FETCH_HEAD");
    if (commit === null) {
      throw new SourceFetchError(s.name, `source ${s.name} (${s.ref}) did not fetch a commit`);
    }
    await cache.run(["update-ref", PINNED, commit]);
    await writeMetadata(cacheDir, {
      name: s.name,
      url,
      ref: s.ref,
      commit,
      fetchedAt: new Date().toISOString(),
    });
    return await served(cache, null);
  } finally {
    await release();
  }
}
