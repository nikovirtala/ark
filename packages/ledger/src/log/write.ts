import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CompiledKind, envelopeFailure } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { MAX_EVENT_BYTES, serializeEvent } from "../envelope/yaml.js";
import { EventExistsError, FileExistsError, InvalidArgumentError } from "../errors.js";
import { assertPath, type Git, requireWorkTree } from "../git/git.js";
import { eventPath, type LogLayout } from "../identity/layout.js";
import { formatAt } from "../identity/time.js";
import { createUlidFactory, ulidTime } from "../identity/ulid.js";

/**
 * An `(at, id)` that sorts after every previous event of the subject, even when two commands run
 * in the same second or the clock steps back: `at` never goes below the latest previous `at`, and
 * on an equal `at` the ULID's time is past the latest id's.
 */
export function nextEventIdentity(
  previous: readonly { readonly at: string; readonly id: string }[],
  o: { readonly now?: () => number; readonly random?: (buf: Uint8Array) => void } = {},
): { at: string; id: string } {
  const now = (o.now ?? Date.now)();
  let latest: { readonly at: string; readonly id: string } | undefined;
  for (const p of previous) {
    if (latest === undefined || p.at > latest.at || (p.at === latest.at && p.id > latest.id)) {
      latest = p;
    }
  }
  const fresh = formatAt(now);
  const at = latest !== undefined && latest.at > fresh ? latest.at : fresh;
  const time =
    latest !== undefined && at === latest.at ? Math.max(now, ulidTime(latest.id) + 1) : now;
  const factory = createUlidFactory({
    now: () => time,
    ...(o.random === undefined ? {} : { random: o.random }),
  });
  return { at, id: factory() };
}

/**
 * Writes a new event file into the work tree and returns its repo-relative path. The event must
 * pass the envelope schema, else `InvalidArgumentError` is thrown and nothing is written. An
 * existing file is never overwritten: that throws `EventExistsError`. `stage` runs `git add`.
 */
export async function writeEvent(
  git: Git,
  layout: LogLayout,
  e: EventEnvelope,
  o: { readonly stage?: boolean } = {},
): Promise<string> {
  const root = requireWorkTree(git);
  const failure = envelopeFailure(e, null);
  if (failure !== null) {
    const why = failure.findings.map((f) => f.message).join("; ");
    throw new InvalidArgumentError(`refusing to write an invalid event: ${why}`);
  }
  const path = eventPath(layout, e);
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  try {
    await writeFile(full, serializeEvent(e), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new EventExistsError(path, { cause: err });
    }
    throw err;
  }
  if (o.stage === true) await git.add([path]);
  return path;
}

const isExists = (err: unknown) => (err as NodeJS.ErrnoException).code === "EEXIST";

/**
 * Writes a batch of new event files and returns their repo-relative paths, in order. Every event
 * is validated with `o.kind` and checked against `MAX_EVENT_BYTES` before anything is written
 * (`InvalidArgumentError`). Files are created exclusively; if one write fails (`EventExistsError`
 * or an fs error), the files already written are removed again before rethrowing. `stage` runs one
 * `git add` after every write succeeded, so a failure leaves nothing written or staged. Never
 * retries: picking a new identity is the caller's decision.
 */
export async function writeEvents(
  git: Git,
  layout: LogLayout,
  events: readonly EventEnvelope[],
  o: { readonly kind: CompiledKind; readonly stage?: boolean },
): Promise<string[]> {
  const root = requireWorkTree(git);
  const files = events.map((e) => {
    const r = o.kind.validate(e, { file: null });
    if (!r.ok) {
      const why = r.findings.map((f) => f.message).join("; ");
      throw new InvalidArgumentError(`refusing to write invalid event ${e.id}: ${why}`);
    }
    const content = serializeEvent(e);
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_EVENT_BYTES) {
      throw new InvalidArgumentError(`event ${e.id} is ${size} bytes; the limit is 1 MiB`);
    }
    return { path: eventPath(layout, e), content };
  });
  const written: string[] = [];
  try {
    for (const { path, content } of files) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      try {
        await writeFile(full, content, { flag: "wx" });
      } catch (err) {
        if (isExists(err)) throw new EventExistsError(path, { cause: err });
        throw err;
      }
      written.push(full);
    }
  } catch (err) {
    for (const full of written) await unlink(full).catch(() => {});
    throw err;
  }
  const paths = files.map((f) => f.path);
  if (o.stage === true) await git.add(paths);
  return paths;
}

/**
 * Creates a new file at the repo-relative `path` (parent directories as needed) and optionally
 * stages it. An existing file is never overwritten: that throws `FileExistsError`.
 */
export async function writeNewFile(
  git: Git,
  path: string,
  content: string | Uint8Array,
  o: { readonly stage?: boolean } = {},
): Promise<void> {
  const root = requireWorkTree(git);
  assertPath(path);
  const segments = path.split("/");
  if (path.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new InvalidArgumentError(`not a repo-relative file path: ${JSON.stringify(path)}`);
  }
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  try {
    await writeFile(full, content, { flag: "wx" });
  } catch (err) {
    if (isExists(err)) throw new FileExistsError(path, { cause: err });
    throw err;
  }
  if (o.stage === true) await git.add([path]);
}
