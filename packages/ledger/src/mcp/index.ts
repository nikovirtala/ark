/**
 * MCP server scaffolding for ledger tools (`@nikovirtala/ledger/mcp`): a tool's library functions
 * served over stdio, with input validation, the tool's JSON documents as results, `ark-error/v1`
 * errors and state headers first. Kept out of the other entries, so only `<tool> mcp` loads the
 * MCP SDK.
 *
 * The error classes are re-exported so users of this entry share the root entry's classes.
 */
export { LedgerError, UsageError } from "../errors.js";
export { mcpAgentName, mcpAttribution } from "./attribution.js";
export {
  checkResourceId,
  doc,
  GLOBS,
  ID,
  MAX_ID,
  type McpSchema,
  object,
  READ,
  SECTIONS,
  SOURCE,
  sectionsOf,
  str,
  strings,
  TEXT,
  WRITE,
} from "./inputs.js";
export { serveMcp } from "./serve.js";
export type {
  McpAnnotations,
  McpContext,
  McpPrompt,
  McpPromptArgument,
  McpResource,
  McpResourceContent,
  McpResourceTemplate,
  McpServeOptions,
  McpServerSpec,
  McpTool,
  McpToolResult,
} from "./types.js";
