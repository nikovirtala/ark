---
"@nikovirtala/ledger": minor
"@nikovirtala/issues": patch
---

An issue's description no longer keeps empty optional sections. ledger's `renderTemplate` and `replaceSections` take `emptyOptional: "drop"`, which leaves an optional section without content out of a render, lets `replaceSections` remove one given empty text, and inserts an absent one in template order; the default `"keep"` behaves as before.

Changed behaviour:
- `issues new` and `issues_open` write no heading for an optional section without content, such as task's Notes or feature's Alternatives.
- `issues edit --section <id>=` and `issues_update` with empty text remove an optional section, and text adds it back in the template's order.
- `issues edit --title`/`--section` that commits refuses a description that fails template lint, such as an empty required section, as `issues new` does (exit 1, nothing written).
