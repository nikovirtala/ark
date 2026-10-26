# Return the CLI's JSON documents from MCP tools

## Context
Every ark CLI prints one JSON document per command under `--json`, and hooks, CI and scripts read those documents. Ledger-based tools also serve MCP tools that agents call for the same operations ([adr: MCP surface](../../01-adr-v1.md#mcp-surface)). If MCP tools returned shapes of their own, each tool would define and document a second set of formats, an agent and a script would see different data for one operation, and every tool would map errors to MCP in its own way. ADR-0004 defines the error document, `ark-error/v1`, and ADR-0006 puts the MCP scaffolding in `@nikovirtala/ledger/mcp`; neither says what an MCP tool returns.

## Decision
An MCP tool of a ledger-based tool returns, as `structuredContent`, the document its CLI prints for the same operation under `--json`, in the same format and version. Inputs that exist only over MCP, such as `adr_search`'s `limit`, may shorten a list in the document but add no fields. The text content starts with the state headers the CLI prints, then the readable text, then the document as JSON.

A write the log's rules refuse is an ordinary result whose document has `ok: false` and the findings, where the CLI exits 1. A `LedgerError` is an `isError` result whose `structuredContent` is the `ark-error/v1` document the CLI would print; any other exception gives the same shape with the code `internal`. Input that fails the tool's JSON Schema is a `usage` error result.

ledger's `./mcp` entry enforces this. A tool's MCP code returns its document, state headers and text, and `serveMcp` builds every result from them (`toolResult` and `errorResult` in `packages/ledger/src/mcp/results.ts`); a document that isn't a JSON object is an `internal` error. Tools don't build MCP results themselves.

## Scope
The MCP servers of every ledger-based tool: the result building in ledger's `./mcp` entry and each tool's MCP tools under `packages/*/src/mcp/`, and the CLI documents they return.

## Consequences
- Agents, scripts and CI read one format per operation, and a format change is one change for both surfaces.
- A new tool gets MCP results by returning its CLI documents, with no MCP-only formats to design or document.
- The document formats are a contract with MCP clients as well as scripts, so a breaking format change affects agents too.
- An agent that needs data the CLI doesn't print needs a CLI change first.
- Refusals arrive as data, not errors, so a client has to read `ok` as well as `isError`.
