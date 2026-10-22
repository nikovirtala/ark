import { InvalidArgumentError } from "../errors.js";

const AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** An envelope timestamp, `YYYY-MM-DDTHH:MM:SSZ` in UTC, truncated to seconds. */
export function formatAt(d: Date | number): string {
  const date = new Date(d);
  const at = Number.isNaN(date.getTime()) ? "" : `${date.toISOString().slice(0, 19)}Z`;
  if (!isAt(at))
    throw new InvalidArgumentError(`date can't be written as an event time: ${String(d)}`);
  return at;
}

/** Matches the `at` pattern and names a real calendar date and time. */
export function isAt(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = AT.exec(s);
  if (m === null) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, sec, 0);
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === sec
  );
}

/** The file-name stamp for an `at`: `2026-10-22T10:15:00Z` → `20261022T101500Z`. */
export function atToStamp(at: string): string {
  if (!isAt(at)) throw new InvalidArgumentError(`invalid event time: ${JSON.stringify(at)}`);
  return at.replace(/[-:]/g, "");
}
