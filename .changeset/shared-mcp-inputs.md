---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger/mcp` exports the MCP input schemas a tool's server shares (`McpSchema`, `MAX_ID`, `ID`, `TEXT`, `SECTIONS`, `GLOBS`, `SOURCE`, `object`, `READ`, `WRITE`), the argument readers (`str`, `strings`, `sectionsOf`, `doc`) and `checkResourceId`, the id-length guard of a resource template. adr's and issues' MCP servers now use these instead of their own copies; the inputs they accept and the messages they give are unchanged.
