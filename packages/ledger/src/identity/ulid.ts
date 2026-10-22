import { randomFillSync } from "node:crypto";
import { InvalidArgumentError, LedgerError } from "../errors.js";
import { decodeCrockford, encodeCrockford } from "./crockford.js";

export interface UlidFactoryOptions {
  /** Milliseconds since the epoch, default `Date.now`. */
  readonly now?: () => number;
  /** Fills the buffer with random bytes, default `crypto.randomFillSync`. */
  readonly random?: (buf: Uint8Array) => void;
  /** Ids sort in generation order even within one millisecond. Default `true`. */
  readonly monotonic?: boolean;
}

const MAX_TIME = 2 ** 48 - 1;
const MAX_RANDOM = (1n << 80n) - 1n;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function timeBytes(ms: number): Uint8Array {
  const out = new Uint8Array(6);
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    out[i] = t % 256;
    t = Math.floor(t / 256);
  }
  return out;
}

function randomBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(10);
  let v = n;
  for (let i = 9; i >= 0; i--) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
}

/** A ULID generator. A monotonic one increments the random part within the same millisecond. */
export function createUlidFactory(o: UlidFactoryOptions = {}): () => string {
  const now = o.now ?? Date.now;
  const random = o.random ?? ((buf: Uint8Array) => randomFillSync(buf));
  const monotonic = o.monotonic ?? true;
  let lastTime = -1;
  let lastRandom = 0n;

  return () => {
    let time = now();
    if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
      throw new InvalidArgumentError(`ulid time out of range: ${time}`);
    }
    let rand: bigint;
    if (monotonic && time <= lastTime) {
      if (lastRandom === MAX_RANDOM) {
        throw new LedgerError(
          "ulid-overflow",
          "ulid random part overflowed within one millisecond",
        );
      }
      time = lastTime;
      rand = lastRandom + 1n;
    } else {
      const buf = new Uint8Array(10);
      random(buf);
      rand = 0n;
      for (const b of buf) rand = (rand << 8n) | BigInt(b);
    }
    lastTime = time;
    lastRandom = rand;
    return encodeCrockford(timeBytes(time), 10) + encodeCrockford(randomBytes(rand), 16);
  };
}

/** The default monotonic factory. */
export const ulid: () => string = createUlidFactory();

/** A canonical (uppercase) ULID. */
export function isUlid(s: unknown): s is string {
  return typeof s === "string" && ULID.test(s);
}

/** The millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new InvalidArgumentError(`not a ulid: ${JSON.stringify(id)}`);
  let t = 0;
  for (const b of decodeCrockford(id.slice(0, 10))) t = t * 256 + b;
  return t;
}
