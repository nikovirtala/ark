---
"@nikovirtala/ledger": patch
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

Every `adr` and `issues` library entry point, CLI command and MCP request now runs as one git operation, so the reads, index renders and verify of one command share one `cat-file --batch` process and the `isShallow` and `symbolicRef` answers until it changes HEAD, a ref or the index. Each MCP request gets its own operation, so nothing carries over between requests. The editor and the `adr accept` scope prompt drop what was cached. One `issues comment` test spawns 235 git processes instead of 338. Results are unchanged.
