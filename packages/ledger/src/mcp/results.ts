import { CommitFailedError, type JsonValue, LedgerError } from "../errors.js";
import { renderStateHeader } from "../surfaces/header.js";
import type { McpToolResult } from "./types.js";

/** A `tools/call` result as the SDK sends it. */
export interface CallResult {
  [k: string]: unknown;
  readonly content: { type: "text"; text: string }[];
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: true;
}

const isObject = (v: JsonValue): v is { readonly [k: string]: JsonValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The state headers, a blank line when there were headers and text, then the text: what a
 * reader sees before anything else is whether the subject is in force.
 */
export function resultText(headers: McpToolResult["headers"], text: string): string {
  const head = headers.map(renderStateHeader).join("");
  return head !== "" && text !== "" ? `${head}\n${text}` : `${head}${text}`;
}

/**
 * A tool's result: the readable text first, then the document as JSON text for clients that
 * ignore `structuredContent`, which is the document itself. A document that isn't a JSON object
 * is a bug in the tool: a plain `TypeError`, so it is reported as internal.
 */
export function toolResult(tool: string, r: McpToolResult): CallResult {
  if (!isObject(r.document)) throw new TypeError(`tool ${tool} returned a non-object document`);
  return {
    content: [
      { type: "text", text: resultText(r.headers, r.text) },
      { type: "text", text: JSON.stringify(r.document, null, 2) },
    ],
    structuredContent: r.document as Record<string, unknown>,
  };
}

/**
 * An `isError` result carrying the `ark-error/v1` document `runCli` prints under `--json`: the
 * error's code for a `LedgerError` (with a failed commit's notes), else `internal`, whose message
 * and stack go to stderr.
 */
export function errorResult(
  err: unknown,
  o: { readonly server: string; readonly stderr: { write(s: string): void } },
): CallResult {
  const known = err instanceof LedgerError;
  const message = err instanceof Error ? err.message : String(err);
  if (!known) {
    const stack = err instanceof Error && err.stack !== undefined ? `${err.stack}\n` : "";
    o.stderr.write(`${o.server}: internal error: ${message}\n${stack}`);
  }
  const code = known ? err.code : "internal";
  const notes =
    err instanceof CommitFailedError ? err.notes.filter((n) => !message.includes(n)) : null;
  const doc = {
    format: "ark-error/v1",
    error: { code, message },
    ...(notes === null ? {} : { notes }),
  };
  return {
    isError: true,
    content: [
      { type: "text", text: `${code}: ${message}` },
      { type: "text", text: JSON.stringify(doc, null, 2) },
    ],
    structuredContent: doc,
  };
}
