import { parse, TomlError } from "smol-toml";
import { ConfigError } from "../errors.js";
import type { TreeReader } from "../git/tree.js";
import { normalizeLayout } from "../identity/layout.js";

/** One `[[sources]]` entry of a `<tool>.toml`: another repository's log, pinned at `ref`. */
export interface SourceConfig {
  /** The qualified-id prefix, unique within one config file. */
  readonly name: string;
  /** An opaque log-type key the tool maps to a kind. */
  readonly kind: string;
  readonly url: string;
  /** A branch, tag or full commit sha. */
  readonly ref: string;
  /** Where the log lives inside the source repository, when not the kind's default. */
  readonly root: string | null;
}

export interface ToolConfig {
  readonly sources: readonly SourceConfig[];
  /** The rest of the document (everything but `sources`), for the tool. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly file: string | null;
}

/** Config files larger than this are rejected without parsing. */
export const MAX_CONFIG_BYTES = 1_048_576;

/**
 * The rule for a `[[sources]]` name, the prefix of a qualified id: a lowercase letter, then up to
 * 31 lowercase letters, digits or `-`. Unanchored, so callers anchor it or embed it in a larger
 * pattern.
 */
export const SOURCE_NAME = "[a-z][a-z0-9-]{0,31}";

const NAME = new RegExp(`^${SOURCE_NAME}$`);

/** Whether `s` is a valid `[[sources]]` name (`SOURCE_NAME`, anchored). */
export function isSourceName(s: string): boolean {
  return NAME.test(s);
}

const KIND = /^[a-z][a-z0-9-]*$/;
const ABBREVIATED_SHA = /^(?:[0-9a-f]{7,39}|[0-9a-f]{41,63})$/;
const encoder = new TextEncoder();

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Whether `v` is a TOML table: an object that isn't an array or a date. */
export function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function validateSource(
  value: unknown,
  index: number,
  fail: (message: string) => ConfigError,
): SourceConfig {
  const where = `sources[${index}]`;
  if (!isTable(value)) throw fail(`${where} must be a table`);
  const str = (key: string, required: boolean): string | null => {
    const v = value[key];
    if (v === undefined) {
      if (required) throw fail(`${where}.${key} is required`);
      return null;
    }
    if (typeof v !== "string") throw fail(`${where}.${key} must be a string`);
    return v;
  };
  const name = str("name", true) ?? "";
  const kind = str("kind", true) ?? "";
  const url = str("url", true) ?? "";
  const ref = str("ref", true) ?? "";
  const root = str("root", false);

  if (!isSourceName(name)) throw fail(`${where}.name must match ^${SOURCE_NAME}$`);
  if (kind.length > 64 || !KIND.test(kind)) {
    throw fail(`${where}.kind must match ${KIND.source} and be at most 64 chars`);
  }
  if (url === "" || url.length > 2048) throw fail(`${where}.url must be 1 to 2048 chars`);
  if (hasControlChar(url)) throw fail(`${where}.url must not contain control characters`);
  if (url.startsWith("-")) throw fail(`${where}.url must not start with -`);
  if (/^(?:ext|fd)::/i.test(url)) throw fail(`${where}.url uses a forbidden transport`);
  if (ref === "" || ref.length > 256) throw fail(`${where}.ref must be 1 to 256 chars`);
  if (/\s/.test(ref) || hasControlChar(ref)) {
    throw fail(`${where}.ref must not contain whitespace or control characters`);
  }
  if (ref.startsWith("-")) throw fail(`${where}.ref must not start with -`);
  if (ref.includes("..")) throw fail(`${where}.ref must not contain ..`);
  // These would make the fetch refspec force-update (+), write a ref in the cache (a:b), match
  // several refs (* ? [), or name a revision git can't fetch (\ ^ ~ @{).
  if (ref.startsWith("+")) throw fail(`${where}.ref must not start with +`);
  if (/[:*?[\\^~]|@\{/.test(ref)) {
    throw fail(`${where}.ref must not contain :, *, ?, [, \\, ^, ~ or @{`);
  }
  if (ABBREVIATED_SHA.test(ref)) {
    throw fail(`${where}.ref looks like an abbreviated commit id; use the full sha`);
  }
  let normalizedRoot: string | null = null;
  if (root !== null) {
    try {
      normalizedRoot = normalizeLayout({ root }).root;
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      throw fail(`${where}.root: ${e.message}`);
    }
  }
  return { name, kind, url, ref, root: normalizedRoot };
}

/** Parses and validates a `<tool>.toml`. Throws `ConfigError` with the file (and line, if known). */
export function parseToolConfig(text: string, o: { readonly file?: string } = {}): ToolConfig {
  const file = o.file ?? null;
  const fail = (message: string, line: number | null = null, cause?: unknown) =>
    new ConfigError(
      file === null ? message : `${file}: ${message}`,
      { file, line },
      cause === undefined ? undefined : { cause },
    );
  const size = encoder.encode(text).byteLength;
  if (size > MAX_CONFIG_BYTES) {
    throw fail(`config is ${size} bytes; the limit is ${MAX_CONFIG_BYTES}`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (e) {
    if (!(e instanceof TomlError)) throw e;
    const first = e.message.split("\n", 1)[0] ?? "";
    throw fail(first, e.line, e);
  }
  const { sources: rawSources, ...raw } = doc;
  let sources: SourceConfig[] = [];
  if (rawSources !== undefined) {
    if (!Array.isArray(rawSources)) throw fail("sources must be an array of tables ([[sources]])");
    sources = rawSources.map((s, i) => validateSource(s, i, fail));
  }
  const seen = new Set<string>();
  sources.forEach((s, i) => {
    if (seen.has(s.name)) throw fail(`sources[${i}].name ${JSON.stringify(s.name)} is not unique`);
    seen.add(s.name);
  });
  return { sources, raw, file };
}

/** Reads and parses `path` from `tree`; `null` when the file is absent. */
export async function readToolConfig(tree: TreeReader, path: string): Promise<ToolConfig | null> {
  const bytes = await tree.read(path);
  if (bytes === null) return null;
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw new ConfigError(
      `${path}: config is ${bytes.byteLength} bytes; the limit is ${MAX_CONFIG_BYTES}`,
      { file: path },
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new ConfigError(`${path}: config is not valid UTF-8`, { file: path }, { cause: e });
  }
  return parseToolConfig(text, { file: path });
}
