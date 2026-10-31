---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports `lookupPaths`, the path handling behind a tool's `for` command (path checks, tracked detection, anchor scan and unresolved anchors), and `listKindTemplates`, the template listing behind a tool's `_templates` tool. adr and issues now use these instead of their own copies; what `adr for`, `issues for`, `adr_templates` and `issues_templates` return is unchanged.
