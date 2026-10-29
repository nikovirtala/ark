import { isMap, LineCounter, parseDocument, Scalar, stringify, type Tags, visit } from "yaml";
import { type Finding, finding } from "../findings/finding.js";
import { ACTOR_KEYS, ENVELOPE_KEYS, type EventEnvelope, unknownFields } from "./types.js";

/** Event files larger than this are reported as `event/too-large` without parsing. */
export const MAX_EVENT_BYTES = 1_048_576;

export type ParseResult =
  | { readonly ok: true; readonly doc: Record<string, unknown> }
  | { readonly ok: false; readonly finding: Finding };

const encoder = new TextEncoder();
const NULLABLE_ACTOR_KEYS = ["email", "agent", "on_behalf_of"] as const;
const STR_TAG = "tag:yaml.org,2002:str";
const BOM = "\uFEFF";

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The first line of a yaml error message, without its position suffix. */
function yamlMessage(message: string): string {
  const first = message.split("\n", 1)[0] ?? "";
  return first.replace(/ at line \d+, column \d+:?$/, "");
}

/**
 * Parses one event file as YAML 1.2 (core schema): strict UTF-8, one document, unique keys, no
 * aliases or merge keys. Every failure is a finding, never a throw.
 */
export function parseEventYaml(
  bytes: Uint8Array | string,
  ctx: { readonly file: string | null },
): ParseResult {
  const { file } = ctx;
  const fail = (rule: string, message: string, line: number | null = null): ParseResult => ({
    ok: false,
    finding: finding({ severity: "error", rule, message, file, line }),
  });
  const size = typeof bytes === "string" ? encoder.encode(bytes).byteLength : bytes.byteLength;
  if (size > MAX_EVENT_BYTES) {
    return fail("event/too-large", `event file is ${size} bytes; the limit is ${MAX_EVENT_BYTES}`);
  }
  let text: string;
  if (typeof bytes === "string") {
    text = bytes;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return fail("event/unparseable", "event file is not valid UTF-8");
    }
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    strict: true,
    prettyErrors: true,
    lineCounter,
  });
  const error = doc.errors[0];
  if (error !== undefined) {
    return fail(
      "event/unparseable",
      `invalid YAML: ${yamlMessage(error.message)}`,
      error.linePos?.[0].line ?? null,
    );
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    let line: number | null = null;
    visit(doc, {
      Alias(_, node) {
        if (node.range) line = lineCounter.linePos(node.range[0]).line;
        return visit.BREAK;
      },
    });
    return fail("event/unparseable", `invalid YAML: ${e.message}`, line);
  }
  if (!isMap(doc.contents) || !isMapping(value)) {
    return fail("event/not-a-mapping", "event is not a mapping");
  }
  return { ok: true, doc: value };
}

/**
 * The canonical form `serializeEvent` writes: known envelope keys in order, then unknown ones; a
 * mapping `actor` gets the same treatment, with absent `email`, `agent` and `on_behalf_of` set to
 * `null`. An absent `reason` stays absent. Pure and idempotent.
 */
export function canonicalEvent<E extends EventEnvelope | Record<string, unknown>>(e: E): E {
  const src = e as Record<string, unknown>;
  const entries: [string, unknown][] = [];
  for (const key of ENVELOPE_KEYS) {
    if (!Object.hasOwn(src, key)) continue;
    const value = src[key];
    entries.push([key, key === "actor" && isMapping(value) ? canonicalActor(value) : value]);
  }
  entries.push(...Object.entries(unknownFields(src, ENVELOPE_KEYS)));
  return Object.fromEntries(entries) as E;
}

function canonicalActor(actor: Record<string, unknown>): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const key of ACTOR_KEYS) {
    if (Object.hasOwn(actor, key)) entries.push([key, actor[key]]);
    else if ((NULLABLE_ACTOR_KEYS as readonly string[]).includes(key)) entries.push([key, null]);
  }
  entries.push(...Object.entries(unknownFields(actor, ACTOR_KEYS)));
  return Object.fromEntries(entries);
}

/** A one-line double-quoted scalar with no escapes other than `\"`. */
const ONLY_QUOTE_ESCAPES = /^"(?:[^"\\\n]|\\")*"$/;
/** An empty first line, two or more trailing newlines, or a line of only spaces and tabs. */
const BLANK_LINES = /^\n|\n\n$|(?:^|\n)[ \t]+(?:\n|$)/;
/** Unicode whitespace that YAML doesn't count as whitespace, at the start or end. */
const EDGE_SPACE = /^[^\S\t\n ]|[^\S\t\n ]$/u;

/** Whether yaml's form of `value` is one biome would change, so it gets double quotes. */
function needsDoubleQuotes(value: string): boolean {
  return value.includes(BOM) || EDGE_SPACE.test(value) || BLANK_LINES.test(value);
}

/**
 * yaml's string tag, written the way `biome format` leaves it. yaml's form stays, except:
 * - A string with `BLANK_LINES` is quoted, with `\n` escapes. As a block scalar, biome would
 *   strip the whitespace of such a line or drop a trailing empty line, and yaml writes `" \n"` as
 *   a block that reads back as `"\n"`.
 * - A string with `EDGE_SPACE` is quoted: biome trims that whitespace off a plain scalar.
 * - A string with U+FEFF is double-quoted with that character escaped: YAML allows a byte order
 *   mark only at the start of a stream, and yaml writes it as it is.
 * - A double-quoted scalar with only `\"` escapes is single-quoted, as biome writes it.
 */
function biomeStrings(tags: Tags): Tags {
  return tags.map((tag) => {
    if (typeof tag !== "object" || tag.tag !== STR_TAG || tag.stringify === undefined) return tag;
    const stringifyStr = tag.stringify;
    return {
      ...tag,
      stringify(item, ctx, onComment, onChompKeep) {
        let scalar = item;
        if (typeof item.value === "string" && needsDoubleQuotes(item.value)) {
          scalar = new Scalar(item.value);
          scalar.type = Scalar.QUOTE_DOUBLE;
        }
        const text = stringifyStr(scalar, ctx, onComment, onChompKeep).replaceAll(BOM, "\\uFEFF");
        if (!text.includes('\\"') || !ONLY_QUOTE_ESCAPES.test(text)) return text;
        return `'${text.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "''")}'`;
      },
    };
  });
}

/** YAML for `canonicalEvent(e)`, ending with a newline, formatted as `biome format` would. */
export function serializeEvent(e: EventEnvelope | Record<string, unknown>): string {
  return stringify(canonicalEvent(e), { lineWidth: 0, nullStr: "null", customTags: biomeStrings });
}
