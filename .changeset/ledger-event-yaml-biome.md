---
"@nikovirtala/ledger": patch
---

`serializeEvent` writes event YAML that `biome format` (2.6.2) leaves as it is, so the commit that adds an event passes `biome check`. Event files already written don't change, and strings other than the ones below are written as before.

Changed behaviour:

- A string with both quote kinds that needs quoting is single-quoted (`'it''s: "both"'`) instead of double-quoted with `\"` escapes.
- A multi-line string with an empty first line, two or more trailing newlines, or a line of only spaces and tabs is double-quoted with `\n` escapes instead of written as a block scalar. Before, biome stripped such lines' whitespace, and `" \n"` was written as a block that read back as `"\n"`.
- A string that starts or ends with Unicode whitespace YAML doesn't count as whitespace (such as U+00A0 or U+2028) is quoted, so biome doesn't trim it.
- A string with U+FEFF is double-quoted with that character escaped as `\uFEFF`. Before, it was written as it is, which YAML allows only at the start of a stream.
