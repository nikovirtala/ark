---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports `indexNumbering`, which turns the numbers read from a committed index (`readIndexNumbers`) into the numbering a tool displays, and `SOURCE_NAME` and `isSourceName`, the pattern and check for a `[[sources]]` name. adr and issues now use these instead of their own copies; what they accept and print is unchanged.
