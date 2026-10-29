---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`compileKind` (and so `defineKind`) no longer loads ajv or compiles a kind's event-data schemas up front: each event type's schema is compiled on its first validation. `adr` and `issues` commands that validate no event, such as `--help`, start about 55–75ms faster. `CompiledKind` gains `compileAll()`, which compiles every data schema at once; call it in a kind's tests.

Changed behaviour:
- A data schema that ajv rejects (an unknown keyword in strict mode, for example) no longer makes `defineKind` or `compileKind` throw. The `KindDefinitionError` comes from the first `validate` of that event type, or from `compileAll()`. The other definition checks still throw at definition time.
