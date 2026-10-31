import { InvalidArgumentError } from "../errors.js";
import { SOURCE_NAME } from "./config.js";

/** A subject id, optionally qualified by a source name: `k3f9q8a1` or `platform:k3f9q8a1`. */
export interface QualifiedId {
  /** The `[[sources]]` name, or `null` for the local log. */
  readonly source: string | null;
  readonly id: string;
}

const QUALIFIED_ID = new RegExp(`^(?:(${SOURCE_NAME}):)?([0-9a-hjkmnp-tv-z]{8})$`);

export function parseQualifiedId(s: string): QualifiedId | null {
  const m = QUALIFIED_ID.exec(s);
  if (m === null) return null;
  return { source: m[1] ?? null, id: m[2] ?? "" };
}

/** Throws `InvalidArgumentError` for a source name or id that wouldn't parse back. */
export function formatQualifiedId(q: QualifiedId): string {
  const s = q.source === null ? q.id : `${q.source}:${q.id}`;
  const back = parseQualifiedId(s);
  if (back === null || back.source !== q.source || back.id !== q.id) {
    throw new InvalidArgumentError(`invalid qualified id: ${JSON.stringify(q)}`);
  }
  return s;
}
