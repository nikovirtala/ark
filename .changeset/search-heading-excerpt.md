---
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`adr search`, `issues search`, `adr_search` and `issues_search` show the matching heading (for example `## Done when`) as the excerpt when a term matches only description headings, instead of an empty `( match)` line. A result without an excerpt names every field it matched in.
