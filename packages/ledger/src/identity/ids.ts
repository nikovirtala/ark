import { randomFillSync } from "node:crypto";
import { encodeCrockford } from "./crockford.js";

const SUBJECT_ID = /^[0-9a-hjkmnp-tv-z]{8}$/;

/**
 * A new subject id: 8 lowercase Crockford base32 chars from 5 fresh random bytes. Never taken from
 * a monotonic ULID stream, whose high random bits repeat within a millisecond.
 */
export function newSubjectId(
  random: (buf: Uint8Array) => void = (buf) => randomFillSync(buf),
): string {
  const buf = new Uint8Array(5);
  random(buf);
  return encodeCrockford(buf, 8).toLowerCase();
}

export function isSubjectId(s: unknown): s is string {
  return typeof s === "string" && SUBJECT_ID.test(s);
}
