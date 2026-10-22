import { isMap, LineCounter, parseDocument, stringify, visit } from "yaml";
import { type Finding, finding } from "../findings/finding.js";
import { ACTOR_KEYS, ENVELOPE_KEYS, type EventEnvelope, unknownFields } from "./types.js";

/** Event files larger than this are reported as `event/too-large` without parsing. */
export const MAX_EVENT_BYTES = 1_048_576;

export type ParseResult =
  | { readonly ok: true; readonly doc: Record<string, unknown> }
  | { readonly ok: false; readonly finding: Finding };

const encoder = new TextEncoder();
const NULLABLE_ACTOR_KEYS = ["email", "agent", "on_behalf_of"] as const;

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

/** YAML for `canonicalEvent(e)`, ending with a newline. */
export function serializeEvent(e: EventEnvelope | Record<string, unknown>): string {
  return stringify(canonicalEvent(e), { lineWidth: 0, nullStr: "null" });
}
