import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { envelopeFailure } from "../envelope/kind.js";
import type { EventEnvelope } from "../envelope/types.js";
import { serializeEvent } from "../envelope/yaml.js";
import { EventExistsError, InvalidArgumentError } from "../errors.js";
import { type Git, requireWorkTree } from "../git/git.js";
import { eventPath, type LogLayout } from "../identity/layout.js";

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
