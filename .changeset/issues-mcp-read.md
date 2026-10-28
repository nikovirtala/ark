---
"@nikovirtala/issues": minor
---

Add `issues mcp`, an MCP server over stdio with the read tools issues_search, issues_get, issues_list, issues_ready, issues_for_path and issues_templates, and the resources `issues://index`, `issues://ready` and `issues://issue/{id}` (the id, the number, or `%3F<number>`). Tools return the CLI's `--json` documents; responses that show an issue lead with its state header, which names the canonical issue of a duplicate and the open blockers of a blocked issue. `issues_search` and `issues_list` take `source` and read it from the local cache. The library exports `listTemplates` (`issues-templates/v1`) and `renderIssueIndexText`.
