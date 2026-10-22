import { InvalidArgumentError } from "../errors.js";

/** Crockford's base32 alphabet (no I, L, O, U), as used by ULIDs. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encodes `bytes`, read as one big-endian number, as exactly `chars` uppercase characters. */
export function encodeCrockford(bytes: Uint8Array, chars: number): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  if (n !== 0n) throw new InvalidArgumentError(`${bytes.length} bytes don't fit in ${chars} chars`);
  return out;
}

/**
 * Decodes canonical Crockford base32 (either case) into `floor(length * 5 / 8)` bytes, the inverse
 * of `encodeCrockford`. Throws `InvalidArgumentError` for other characters or an overflow.
 */
export function decodeCrockford(s: string): Uint8Array {
  let n = 0n;
  for (const c of s.toUpperCase()) {
    const v = CROCKFORD.indexOf(c);
    if (v < 0) throw new InvalidArgumentError(`invalid base32 character: ${JSON.stringify(c)}`);
    n = (n << 5n) | BigInt(v);
  }
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  if (n !== 0n) throw new InvalidArgumentError(`base32 value too large: ${s}`);
  return out;
}
