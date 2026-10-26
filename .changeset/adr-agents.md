---
"@nikovirtala/adr": minor
---

Add `adr mcp`, an MCP server over stdio with the tools adr_search, adr_get, adr_list, adr_templates, adr_propose, adr_update_draft, adr_note, adr_link, adr_for_path, adr_scope and adr_withdraw, plus adr_accept, adr_reject, adr_deprecate and adr_supersede when `[policy] mcp_can_decide = true`; the resources `adr://index` and `adr://decision/{id}` (id, number or ADR-NNNN); and the prompt adr_draft_from_discussion. Tools return the same JSON documents as the CLI's `--json`. Add `adr search <query>… [--all]`, and `adr init --skill [--skill-dir <path>]`, which writes SKILL.md and a pointer line in AGENTS.md. New library functions: `searchDecisions`, `listTemplates`, `updateDraft`, `sourcesNote`, `SKILL_MD`.

Changed behaviour:
- `adr list`, `adr for` and `adr search` add a note (stderr and JSON `notes`) when `[[sources]]` are configured: only the local log is read until ark's step 4.
- `adr-write/v1`'s `command` can be `"update"`; `adr-init/v1` gains `skill`; `DecisionsRead` gains `sources`.
- Installing adr now installs `@modelcontextprotocol/sdk` through `@nikovirtala/ledger`.
