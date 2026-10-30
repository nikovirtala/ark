---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

A `[[sources]]` entry may point at a SHA-256 repository. Each source cache uses its source's object format, and a cache whose format no longer matches its source is recreated. `Git.initBare` takes `{ objectFormat }`.

Changed behaviour:
- A SHA-256 source fetches, pins and reads instead of failing with `cannot fetch source … mismatched algorithms`.
- A cache whose source changed object format is recreated, and its old pin is dropped instead of being served as stale.
