---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports `initToolLog`, the `init` steps adr and issues shared by copy: config placement, built-in templates, the committed `index.md` with its recovery hint and refresh, the agent skill and the `AGENTS.md` pointer with their checks and rollback, the optional empty `.gitkeep` removal and the commit, with the types `ToolInitSpec`, `ToolInitOptions` and `ToolInitResult`, and `namesSkill`, which tells whether a text names the skill's path. `adr init` and `issues init` now use them; their output, JSON documents and `--help` are unchanged.
