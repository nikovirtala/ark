import { type JsonValue, UsageError } from "../errors.js";
import { MAX_GLOB_LENGTH } from "../scope/glob.js";
import { SOURCE_NAME } from "../sources/config.js";

/** A JSON Schema (2020-12 keywords), as `McpTool.inputSchema` and its properties take it. */
export type McpSchema = Readonly<Record<string, JsonValue>>;

/** The longest subject id or number a tool's MCP input or resource URI takes. */
export const MAX_ID = 64;

/** A subject of this log: its id or its number, in any form the tool resolves. */
export const ID: McpSchema = { type: "string", minLength: 1, maxLength: MAX_ID };
/** Note, comment and reason text. */
export const TEXT: McpSchema = { type: "string", minLength: 1, maxLength: 65_536 };
/** Section id → markdown. */
export const SECTIONS: McpSchema = {
  type: "object",
  propertyNames: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 64 },
  additionalProperties: { type: "string", maxLength: 65_536 },
  maxProperties: 50,
};
/** Scope globs, each at most `MAX_GLOB_LENGTH` characters. */
export const GLOBS: McpSchema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: MAX_GLOB_LENGTH },
  maxItems: 200,
};
/** A `[[sources]]` name (`SOURCE_NAME`, anchored), read from the local cache. */
export const SOURCE: McpSchema = { type: "string", pattern: `^${SOURCE_NAME}$` };

/** A tool's input schema: these properties, `required` when any are, and no others. */
export const object = (
  properties: Record<string, McpSchema>,
  required: string[] = [],
): McpSchema => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

/** The annotations of a tool that only reads the log. */
export const READ = { readOnlyHint: true, openWorldHint: false } as const;
/** The annotations of a tool that writes to the log. */
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** A string input, or `undefined` when absent. */
export const str = (v: JsonValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
/** The strings of an array input, or `undefined` when absent. */
export const strings = (v: JsonValue | undefined): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
/** The string entries of a `SECTIONS` input; `{}` when absent. */
export const sectionsOf = (v: JsonValue | undefined): Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? [[k, x]] : [])),
      )
    : {};

/** A library document as a tool result's `document`. */
export const doc = (d: unknown): JsonValue => d as JsonValue;

/**
 * A resource template's guard on its `{id}`: throws `UsageError` (−32602) naming the `noun` when
 * the id is longer than `MAX_ID`, before the tool reads the log.
 */
export function checkResourceId(id: string, noun: string): void {
  if (id.length > MAX_ID) {
    throw new UsageError(
      `invalid ${noun} ${JSON.stringify(`${id.slice(0, MAX_ID)}…`)}: an id or number is at most ${MAX_ID} characters`,
    );
  }
}
