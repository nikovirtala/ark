---
"@nikovirtala/ledger": minor
"@nikovirtala/issues": minor
---

`issues new` (and `issues_open`) leave out an optional template section that has no content, heading and all, except in a draft opened in the editor. `issues edit --section <id>=` (and `issues_update`) with empty text removes an optional section, and `--section <id>=<text>` adds it back in the template's order. ledger's `renderTemplate` and `replaceSections` take `dropEmptyOptional` for this.
