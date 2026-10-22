import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256 of a body with CRLF normalized to LF, so a CRLF checkout hashes the same
 * as the LF blob. For LF files it equals `sha256sum`.
 */
export function bodySha256(bytes: Uint8Array): string {
  const lf = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b === 0x0d && bytes[i + 1] === 0x0a) continue;
    lf[n++] = b;
  }
  return createHash("sha256").update(lf.subarray(0, n)).digest("hex");
}

/** Groups items by key, keeping only keys shared by two or more items. */
export function findDuplicates<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }
  for (const [k, group] of groups) if (group.length < 2) groups.delete(k);
  return groups;
}
