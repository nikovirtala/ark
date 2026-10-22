import { ConfigError, InvalidArgumentError } from "../errors.js";
import { eventFileName } from "./files.js";
import { isSubjectId } from "./ids.js";

/** Where a log lives: `root`, with `events` and `bodies` relative to it. */
export interface LogLayout {
  readonly root: string;
  /** Body directory, or `null` when the kind has no bodies. */
  readonly bodies: string | null;
  readonly events: string;
}

export type PathClass =
  /** `subject` is `null` when the directory isn't a valid id, or the file sits directly in `events`. */
  | { readonly area: "event"; readonly subject: string | null; readonly file: string }
  | { readonly area: "body"; readonly file: string }
  | { readonly area: "log-other" }
  | { readonly area: "outside" };

function normalizeDir(name: string, value: string): string {
  let v = value;
  while (v.startsWith("./")) v = v.slice(2);
  v = v.replace(/\/+$/, "");
  const reject = (why: string) => new ConfigError(`layout ${name} ${JSON.stringify(value)} ${why}`);
  if (v.includes("\\")) throw reject("must use forward slashes");
  if (v.startsWith("/")) throw reject("must be relative to the repository root");
  const segments = v.split("/");
  if (segments.some((s) => s === "")) throw reject("has an empty path segment");
  if (segments.includes("..")) throw reject("must not contain ..");
  // Tree paths never contain `.` segments, so a layout that kept one would match no file.
  const kept = segments.filter((s) => s !== ".");
  if (kept.length === 0) throw reject("must name a directory below the repository root");
  return kept.join("/");
}

/** Validates and normalizes a layout; throws `ConfigError`. */
export function normalizeLayout(l: {
  readonly root: string;
  readonly bodies?: string | null;
  readonly events?: string;
}): LogLayout {
  const root = normalizeDir("root", l.root);
  const events = normalizeDir("events", l.events ?? "events");
  const bodies =
    l.bodies === undefined || l.bodies === null ? null : normalizeDir("bodies", l.bodies);
  if (bodies === events) {
    throw new ConfigError(`layout events and bodies must differ (both ${JSON.stringify(events)})`);
  }
  return { root, bodies, events };
}

export function eventDir(l: LogLayout, subject: string): string {
  if (!isSubjectId(subject)) {
    throw new InvalidArgumentError(`invalid subject id: ${JSON.stringify(subject)}`);
  }
  return `${l.root}/${l.events}/${subject}`;
}

export function eventPath(
  l: LogLayout,
  e: { readonly subject: string; readonly at: string; readonly id: string; readonly type: string },
): string {
  return `${eventDir(l, e.subject)}/${eventFileName(e)}`;
}

/** Which part of a log a repo-relative path belongs to. */
export function classifyPath(l: LogLayout, path: string): PathClass {
  const eventsPrefix = `${l.root}/${l.events}/`;
  if (path.startsWith(eventsPrefix)) {
    const rest = path.slice(eventsPrefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) return { area: "event", subject: null, file: rest };
    const dir = rest.slice(0, slash);
    return { area: "event", subject: isSubjectId(dir) ? dir : null, file: rest.slice(slash + 1) };
  }
  if (l.bodies !== null) {
    const bodiesPrefix = `${l.root}/${l.bodies}/`;
    if (path.startsWith(bodiesPrefix))
      return { area: "body", file: path.slice(bodiesPrefix.length) };
  }
  if (path.startsWith(`${l.root}/`)) return { area: "log-other" };
  return { area: "outside" };
}
