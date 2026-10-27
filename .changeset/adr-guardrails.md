---
"@nikovirtala/adr": minor
---

References into other repositories' decision logs are checked against ledger's source cache: `adr verify` checks cached sources and warns once per uncached one (`sources/not-fetched`), `adr verify --fetch-sources` fetches first and exits 2 when a fetch fails, and `adr sources fetch` refreshes the cache (entries of other kinds are skipped). `adr list --source`, `adr search --source` and the MCP list tool read a cached source. `adr verify --staged` checks every decision when the staged changes touch `adr.toml` or the templates. A commit that sweeps in staged events of other types gets a subject naming them (`docs(adr): link and scope ADR-0003`, `update ADR-0003` beyond three verbs, or the title form of a swept-in status event), its trailers have one pair per decision and event type, and the shortened-title note names the 72-character limit of the description. Single-action subjects are unchanged.

Changed behaviour:

- A proposed decision's scope globs may name code that doesn't exist yet: `scope/glob-unmatched` is reported only for accepted decisions, and `adr accept` notes each glob that still matches nothing.
- `verify` reports `decision/unknown-source` (error) for a qualified reference into a source that isn't in `[[sources]]`, which 0.4.0 skipped, so a log with such a reference starts failing.
- The stricter `[[sources]] ref` rule of ledger.
- The pre-push hook passes `--fetch-sources`; rerun `adr hooks install` to update an installed hook. With a configured source, pushing offline then exits 2; `git push --no-verify` skips it, and CI stays the guard.
