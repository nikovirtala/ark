---
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`adr search` and `issues search` (and `adr_search` and `issues_search`) show the matching heading as the excerpt when a word appears in the description only in a `#` heading, such as `## Consequences` or `## Done when`. Before, such a result printed an empty `( match)` line.

Changed behaviour:
- `results[].excerpt` in `adr-search/v1` and `issues-search/v1` is the heading line instead of `null` when headings hold the description's only hits.
