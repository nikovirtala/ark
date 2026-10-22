import fc from "fast-check";
import type { EventFileName } from "../identity/files.js";
import { newSubjectId } from "../identity/ids.js";
import { atToStamp, formatAt } from "../identity/time.js";
import { createUlidFactory } from "../identity/ulid.js";

const fill = (bytes: Uint8Array) => (buf: Uint8Array) => buf.set(bytes);

export function arbSubjectId(): fc.Arbitrary<string> {
  return fc.uint8Array({ minLength: 5, maxLength: 5 }).map((b) => newSubjectId(fill(b)));
}

export function arbUlid(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.integer({ min: 0, max: 2 ** 48 - 1 }),
      fc.uint8Array({ minLength: 10, maxLength: 10 }),
    )
    .map(([time, b]) =>
      createUlidFactory({ now: () => time, random: fill(b), monotonic: false })(),
    );
}

/** Event times from 1970 to 9999, second precision. */
export function arbAt(): fc.Arbitrary<string> {
  return fc
    .date({
      min: new Date("1970-01-01T00:00:00Z"),
      max: new Date("9999-12-31T23:59:59Z"),
      noInvalidDate: true,
    })
    .map(formatAt);
}

export function arbEventType(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9]{0,11}$/),
      fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { maxLength: 4 }),
    )
    .map(([head, rest]) => [head, ...rest].join("-"));
}

export function arbEventFileName(): fc.Arbitrary<EventFileName> {
  return fc.record({
    stamp: arbAt().map(atToStamp),
    rand: arbUlid().map((id) => id.slice(-4).toLowerCase()),
    type: arbEventType(),
  });
}

/** Valid slugs of at most 60 chars, including `""`. */
export function arbSlug(): fc.Arbitrary<string> {
  return fc
    .array(fc.stringMatching(/^[a-z0-9]{1,10}$/), { maxLength: 5 })
    .map((words) => words.join("-"));
}
