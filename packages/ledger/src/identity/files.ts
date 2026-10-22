import { InvalidArgumentError } from "../errors.js";
import { isSubjectId } from "./ids.js";
import { atToStamp, isAt } from "./time.js";
import { isUlid } from "./ulid.js";

export interface EventFileName {
  /** `20261022T101500Z`, from the envelope's `at`. */
  readonly stamp: string;
  /** The last 4 chars of the event's ULID, lowercased. */
  readonly rand: string;
  readonly type: string;
}

const EVENT_FILE = /^(\d{8}T\d{6}Z)-([0-9a-hjkmnp-tv-z]{4})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.yaml$/;
const EVENT_TYPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STAMP = /^\d{8}T\d{6}Z$/;
const RAND = /^[0-9a-hjkmnp-tv-z]{4}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BODY_FILE = /^([0-9a-hjkmnp-tv-z]{8})(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?\.md$/;

/** A kebab-case event type of at most 64 chars. */
export function isEventType(s: unknown): s is string {
  return typeof s === "string" && s.length <= 64 && EVENT_TYPE.test(s);
}

/** The file name an event must have: a function of its `at`, `id` and `type`. */
export function eventFileName(e: {
  readonly at: string;
  readonly id: string;
  readonly type: string;
}): string {
  if (!isAt(e.at)) throw new InvalidArgumentError(`invalid event time: ${JSON.stringify(e.at)}`);
  if (!isUlid(e.id)) throw new InvalidArgumentError(`invalid event id: ${JSON.stringify(e.id)}`);
  return formatEventFileName({
    stamp: atToStamp(e.at),
    rand: e.id.slice(-4).toLowerCase(),
    type: e.type,
  });
}

export function formatEventFileName(n: EventFileName): string {
  if (!STAMP.test(n.stamp))
    throw new InvalidArgumentError(`invalid stamp: ${JSON.stringify(n.stamp)}`);
  if (!RAND.test(n.rand)) throw new InvalidArgumentError(`invalid rand: ${JSON.stringify(n.rand)}`);
  if (!isEventType(n.type)) {
    throw new InvalidArgumentError(`invalid event type: ${JSON.stringify(n.type)}`);
  }
  return `${n.stamp}-${n.rand}-${n.type}.yaml`;
}

export function parseEventFileName(name: string): EventFileName | null {
  const m = EVENT_FILE.exec(name);
  if (m === null) return null;
  const [, stamp = "", rand = "", type = ""] = m;
  return isEventType(type) ? { stamp, rand, type } : null;
}

/**
 * A file-name slug: NFKD, marks stripped, lowercase ASCII alphanumerics joined by single `-`, cut
 * at a `-` so it's at most `max` chars (a single longer word is cut at `max`). May be `""`.
 */
export function slugify(title: string, max = 60): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug;
  if (slug[max] === "-") return slug.slice(0, max);
  const cut = slug.slice(0, max);
  const dash = cut.lastIndexOf("-");
  return dash > 0 ? cut.slice(0, dash) : cut;
}

export function bodyFileName(id: string, slug: string): string {
  if (!isSubjectId(id)) throw new InvalidArgumentError(`invalid subject id: ${JSON.stringify(id)}`);
  if (slug === "") return `${id}.md`;
  if (!SLUG.test(slug)) throw new InvalidArgumentError(`invalid slug: ${JSON.stringify(slug)}`);
  return `${id}-${slug}.md`;
}

export function parseBodyFileName(name: string): { id: string; slug: string } | null {
  const m = BODY_FILE.exec(name);
  if (m === null) return null;
  return { id: m[1] ?? "", slug: m[2] ?? "" };
}
