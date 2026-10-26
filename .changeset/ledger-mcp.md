---
"@nikovirtala/ledger": minor
---

Add the `@nikovirtala/ledger/mcp` entry: `serveMcp` serves a tool's library functions as an MCP server over stdio, with JSON Schema input validation, the tool's JSON document as `structuredContent`, state headers before any body, `ark-error/v1` error results, one request at a time, and agent attribution from the MCP client's name (`mcpAttribution`, `mcpAgentName`). Also add `replaceFile` (replace a file only if it still holds the expected bytes), `FileChangedError` (code `file-changed`) and `replaceSections` (replace template sections in place, keeping every other line).

Changed behaviour:
- `@modelcontextprotocol/sdk` 1.32.2 is a new dependency (about 92 packages, 25 MB installed). Only the `mcp` entry loads it.
- `LedgerErrorCode` gains `"file-changed"`; an exhaustive `switch` over it needs the new case.
