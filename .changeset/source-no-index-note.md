---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`issues list --source <name>`, `issues search --source <name>`, `adr list --source <name>` and `adr search --source <name>` say that a cached source has no committed `index.md` when that is why its numbers are unavailable, for example `issue numbers are unavailable (platform has no committed index.md); issues display by id`, instead of "no main branch". ledger exports `NO_INDEX_NUMBERING`, whose `reason` is `"no-index"`.

Changed behaviour:
- `numbering.reason` in `issues-list/v1` and `adr-list/v1` is `"no-index"` for a `--source` log without a committed index.
- `adr search --source <name>` prints the note for such a source.
