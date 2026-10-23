import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { envelopeFailure } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { EventExistsError, InvalidArgumentError } from "../errors.js";
import { type Git, requireWorkTree } from "../git/git.js";
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
