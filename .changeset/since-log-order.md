---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`adr list --since` and `issues list --since` (and so the post-merge hooks) list a subject's new events in log order, `(at, id)` as the fold applies them. Before, they were sorted by file path, so two events written in the same second could print in the wrong order, such as `[new: accepted, proposed]`. ledger exports `sortInLogOrder`, which sorts event paths that way by reading each file's `at` and `id` from a tree.

Changed behaviour:
- `since.events` in `adr-list/v1` and `issues-list/v1` is in log order, not path order.
