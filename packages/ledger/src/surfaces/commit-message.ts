/**
 * Commit messages from a one-line subject template (design §4): `[commit] subject` in a tool's
 * config, rendered as a Conventional Commits header whose description stays within 72 characters.
 */
import { ConfigError, UsageError } from "../errors.js";
import type { ToolConfig } from "../sources/config.js";

/** The longest description (the subject after a Conventional prefix), in UTF-16 code units. */
export const MAX_DESCRIPTION = 72;
const MAX_TEMPLATE = 200;
/** Room the fixed part of a description must leave for the title. */
const MIN_TITLE_ROOM = 20;
/** The longest Conventional prefix, `: ` included, so the header stays within 100. */
const MAX_PREFIX = 28;
const MAX_MESSAGE_BYTES = 65_536;
const PREFIX = /^[a-z][a-z0-9-]*(\([^()\r\n]+\))?!?: /;
const NAME = /^[a-z][a-z0-9_]*$/;
const TITLE_VARS = new Set(["title", "raw_title"]);

/** A parsed subject template; `vars` maps each tool placeholder to its longest value's length. */
export interface CommitTemplate {
  readonly source: string;
  readonly vars: Readonly<Record<string, number>>;
}

/**
 * A name the title placeholder can hold instead of a title: its longest `length`, and the
 * placeholder lengths that go with it (such as a shorter `action`).
 */
export interface CommitName {
  readonly length: number;
  readonly vars: Readonly<Record<string, number>>;
}

export interface RenderedCommit {
  /** The subject, a blank line and the body, without trailers. */
  readonly message: string;
  readonly subject: string;
  /** The title was shortened to keep the description within 72 characters. */
  readonly shortened: boolean;
}

type Part = { readonly text: string } | { readonly name: string };

/** Splits a template into text and placeholders; `null` for a stray brace. */
function tokenize(source: string): Part[] | null {
  const parts: Part[] = [];
  let text = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if ((c === "{" || c === "}") && source[i + 1] === c) {
      text += c;
      i++;
    } else if (c === "{") {
      const end = source.indexOf("}", i);
      if (end === -1) return null;
      if (text !== "") parts.push({ text });
      text = "";
      parts.push({ name: source.slice(i + 1, end) });
      i = end;
    } else if (c === "}") {
      return null;
    } else {
      text += c;
    }
  }
  if (text !== "") parts.push({ text });
  return parts;
}

/**
 * Splits the parts at the end of the Conventional prefix, found with every placeholder read as a
 * single letter. The prefix ends in ": ", so the split always falls in or after a text part.
 */
function splitPrefix(parts: readonly Part[]): { head: Part[]; tail: Part[] } {
  const m = PREFIX.exec(parts.map((p) => ("text" in p ? p.text : "x")).join(""));
  if (m === null) return { head: [], tail: [...parts] };
  const head: Part[] = [];
  const tail: Part[] = [];
  let left = m[0].length;
  for (const p of parts) {
    const size = "text" in p ? p.text.length : 1;
    if (left <= 0) tail.push(p);
    else if (size <= left || !("text" in p)) head.push(p);
    else {
      head.push({ text: p.text.slice(0, left) });
      tail.push({ text: p.text.slice(left) });
    }
    left -= size;
  }
  return { head, tail };
}

const isTitle = (p: Part) => "name" in p && TITLE_VARS.has(p.name);

/**
 * Parses a subject template: one line of 1–200 characters, `{name}` placeholders for `{title}`,
 * `{raw_title}` and the tool's `vars`, `{{`/`}}` for literal braces. At most one title placeholder,
 * after the type and scope; the prefix can't exceed 28 characters and the fixed part of the
 * description must leave 20 for the title (or fit in 72 without one). Each of `names` is a way
 * the title placeholder can hold a name rather than a title (such as `ADR-0001 with ADR-0002`):
 * the name's longest length and the placeholder lengths that go with it. A name is never
 * shortened, so the description must fit it in 72 at those lengths. Throws `ConfigError` naming
 * `where` (e.g. `"docs/adr/adr.toml: commit.subject"`).
 */
export function parseCommitTemplate(
  text: string,
  o: {
    readonly vars: Readonly<Record<string, number>>;
    readonly where: string;
    readonly names?: readonly CommitName[] | undefined;
  },
): CommitTemplate {
  const fail = (message: string) => new ConfigError(message);
  const { where } = o;
  if (/[\r\n]/.test(text)) throw fail(`${where} must be one line`);
  if (text.length === 0 || text.length > MAX_TEMPLATE) {
    throw fail(`${where} must be 1 to ${MAX_TEMPLATE} characters`);
  }
  const parts = tokenize(text);
  if (parts === null) throw fail(`${where} has a stray { or }; write {{ or }} for a literal brace`);
  const known = (name: string) => TITLE_VARS.has(name) || Object.hasOwn(o.vars, name);
  for (const p of parts) {
    if ("name" in p && (!NAME.test(p.name) || !known(p.name))) {
      const names = ["title", "raw_title", ...Object.keys(o.vars)].map((n) => `{${n}}`);
      throw fail(`${where} uses unknown placeholder {${p.name}}; use ${names.join(", ")}`);
    }
  }
  const titles = parts.filter(isTitle).length;
  if (titles > 1) throw fail(`${where} can use {title} or {raw_title} once`);

  const { head, tail } = splitPrefix(parts);
  if (head.some(isTitle)) throw fail(`${where}: the title must come after the type and scope`);
  // Every placeholder at its longest value, the title at none.
  const longest = (ps: readonly Part[], vars = o.vars) =>
    ps.reduce((n, p) => {
      if ("text" in p) return n + p.text.length;
      return n + (TITLE_VARS.has(p.name) ? 0 : (vars[p.name] ?? 0));
    }, 0);
  if (longest(head) > MAX_PREFIX) {
    throw fail(`${where}: the type and scope can push the header past 100 characters`);
  }
  const fixed = longest(tail);
  const tooLong = (n: CommitName) =>
    longest(tail, { ...o.vars, ...n.vars }) + n.length > MAX_DESCRIPTION;
  if (titles === 1 && (fixed > MAX_DESCRIPTION - MIN_TITLE_ROOM || (o.names ?? []).some(tooLong))) {
    throw fail(`${where} leaves no room for the title`);
  }
  if (titles === 0 && fixed > MAX_DESCRIPTION) {
    throw fail(`${where} can exceed ${MAX_DESCRIPTION} characters`);
  }
  return { source: text, vars: { ...o.vars } };
}

/**
 * The `[commit] subject` of a tool config, else `defaultSubject`, parsed with `names` (see
 * `parseCommitTemplate`). `[commit]` must be a table and `subject` a string; other keys are
 * ignored.
 */
export function readCommitTemplate(
  config: ToolConfig | null,
  o: {
    readonly file: string | null;
    readonly vars: Readonly<Record<string, number>>;
    readonly defaultSubject: string;
    readonly names?: readonly CommitName[];
  },
): CommitTemplate {
  const file = o.file ?? config?.file ?? null;
  const at = (key: string) => (file === null ? key : `${file}: ${key}`);
  const commit = config?.raw.commit;
  if (commit === undefined) {
    return parseCommitTemplate(o.defaultSubject, {
      vars: o.vars,
      where: "commit.subject",
      names: o.names,
    });
  }
  if (typeof commit !== "object" || commit === null || Array.isArray(commit)) {
    throw new ConfigError(`${at("commit")} must be a table`, { file });
  }
  const subject = (commit as Record<string, unknown>).subject;
  if (subject === undefined) {
    return parseCommitTemplate(o.defaultSubject, {
      vars: o.vars,
      where: "commit.subject",
      names: o.names,
    });
  }
  if (typeof subject !== "string") {
    throw new ConfigError(`${at("commit.subject")} must be a string`, { file });
  }
  try {
    return parseCommitTemplate(subject, {
      vars: o.vars,
      where: at("commit.subject"),
      names: o.names,
    });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new ConfigError(e.message, { file }, { cause: e });
  }
}

/** Whitespace runs collapsed, trimmed, every trailing `.` removed. */
function prepareTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim();
}

/**
 * `title` with its first letter lowercased when its first word (its leading run of non-space
 * characters) is an ordinary capitalized word (`Use` → `use`, `A` → `a`). A first word with an
 * uppercase letter after its first character, or whose second character is a digit or `_`, is
 * kept (`CLI`, `ARK_AGENT`, `GraphQL`, `TypeScript`, `IPv6`, `X11`, `ADR-0006`), as is one that
 * already starts in lowercase (`iOS`). Nothing else changes.
 */
function inSentence(title: string): string {
  const [first, second, ...rest] = Array.from(/^\S*/u.exec(title)?.[0] ?? "");
  if (first === undefined || !/^[\p{Lu}\p{Lt}]$/u.test(first)) return title;
  if (second !== undefined && /^[\p{Nd}_]$/u.test(second)) return title;
  if ([second, ...rest].some((c) => c !== undefined && /^[\p{Lu}\p{Lt}]$/u.test(c))) return title;
  return `${first.toLowerCase()}${title.slice(first.length)}`;
}

/** `subject` with the first letter of its description (after any Conventional prefix) lowercased. */
function lowerFirstOfDescription(subject: string): string {
  const at = PREFIX.exec(subject)?.[0].length ?? 0;
  const first = subject.codePointAt(at);
  if (first === undefined) return subject;
  const c = String.fromCodePoint(first);
  return `${subject.slice(0, at)}${c.toLowerCase()}${subject.slice(at + c.length)}`;
}

/** The subject with `title` as the title placeholder's value. */
function substitute(t: CommitTemplate, title: string, vars: Readonly<Record<string, string>>) {
  const parts = tokenize(t.source) ?? [];
  const text = parts
    .map((p) => ("text" in p ? p.text : TITLE_VARS.has(p.name) ? title : (vars[p.name] ?? "")))
    .join("");
  return lowerFirstOfDescription(
    text
      .replace(/ +/g, " ")
      .replace(/[. ]+$/, "")
      .trim(),
  );
}

const description = (subject: string) => subject.slice(PREFIX.exec(subject)?.[0].length ?? 0);

/** `title` cut to at most `budget` code units at a word boundary when one is near, plus `…`. */
function shorten(title: string, budget: number): string {
  const space = title.lastIndexOf(" ", budget);
  let cut = space >= budget / 2 ? space : budget;
  const before = title.charCodeAt(cut - 1);
  if (cut === budget && before >= 0xd800 && before <= 0xdbff) cut--;
  return `${title.slice(0, cut).replace(/[ .,;:-]+$/, "")}…`;
}

/**
 * Renders a commit message (design §4.2–4.5). `title` is the title as recorded: `{raw_title}` gets
 * it with whitespace collapsed and trailing dots removed, `{title}` the same with an ordinary
 * capitalized first word lowercased (`Use` → `use`; `CLI`, `GraphQL`, `ARK_AGENT` stay). The
 * description's first letter is always lowercased and the rest keeps its natural casing. A
 * description over 72 characters gets a shortened title, and the body then starts with
 * `Full title: <title>`. Body paragraphs are wrapped at 72.
 */
export function renderCommitMessage(
  t: CommitTemplate,
  o: {
    readonly title: string | null;
    readonly vars: Readonly<Record<string, string>>;
    readonly body?: readonly string[];
  },
): RenderedCommit {
  const raw = prepareTitle(o.title ?? "");
  const parts = tokenize(t.source) ?? [];
  const lower = parts.some((p) => "name" in p && p.name === "title");
  const title = lower ? inSentence(raw) : raw;
  let subject = substitute(t, title, o.vars);
  let shortened = false;
  const desc = description(subject);
  if (desc.length > MAX_DESCRIPTION && title !== "" && parts.some(isTitle)) {
    const budget = MAX_DESCRIPTION - (desc.length - title.length) - 1;
    subject = substitute(t, shorten(title, Math.max(budget, 1)), o.vars);
    shortened = true;
  }
  const paragraphs = [
    ...(shortened && o.title !== null ? [`Full title: ${o.title}`] : []),
    ...(o.body ?? []),
  ];
  const lines: string[] = [];
  for (const p of paragraphs) {
    const wrapped = wrapParagraph(p);
    if (wrapped.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(...wrapped);
  }
  const message = lines.length === 0 ? subject : `${subject}\n\n${lines.join("\n")}`;
  return { message, subject, shortened };
}

/** `--message` text: trimmed, non-empty, no NUL, at most 64 KiB; else `UsageError`. */
export function checkCommitMessage(text: string): string {
  const message = text.trim();
  if (message === "") throw new UsageError("the commit message is empty");
  if (message.includes("\0")) throw new UsageError("the commit message contains a NUL character");
  const bytes = new TextEncoder().encode(message).byteLength;
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new UsageError(`the commit message is ${bytes} bytes; the limit is ${MAX_MESSAGE_BYTES}`);
  }
  return message;
}

/** `word` in pieces of at most `width` code units, never splitting a surrogate pair. */
function chunks(word: string, width: number): string[] {
  const out: string[] = [];
  let rest = word;
  while (rest.length > width) {
    let cut = width;
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff && cut > 1) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

/**
 * Splits `text` into paragraphs at blank lines, collapses whitespace inside each, and wraps each
 * at `width`, breaking at spaces (a longer word is broken every `width` characters). Returns the
 * lines, with `""` between paragraphs; empty paragraphs are dropped.
 */
export function wrapParagraph(text: string, width = MAX_DESCRIPTION): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      if (current.length > 0) paragraphs.push(current.join(" "));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));

  const out: string[] = [];
  for (const p of paragraphs) {
    const words = p.replace(/\s+/g, " ").trim().split(" ");
    if (words.length === 1 && words[0] === "") continue;
    if (out.length > 0) out.push("");
    let line = "";
    for (const word of words) {
      if (line !== "" && line.length + 1 + word.length <= width) {
        line += ` ${word}`;
        continue;
      }
      if (line !== "") out.push(line);
      const pieces = chunks(word, width);
      out.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1] as string;
    }
    if (line !== "") out.push(line);
  }
  return out;
}
