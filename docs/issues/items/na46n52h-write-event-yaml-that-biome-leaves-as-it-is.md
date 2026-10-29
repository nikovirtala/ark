# Write event YAML that biome leaves as it is

## Summary
An event whose string holds a double quote is written with double quotes, which `biome check` (part of `pnpm lint`) reformats to single quotes, so the commit that adds the event fails lint.

## Steps to reproduce
1. At 8754617, run `issues close <id> --commit --reason 'see "Notes"'`.
2. Run `pnpm lint`.

## Expected
The event file passes `biome check` as written.

## Actual
Lint fails with `Formatter would have printed the following content`: biome wants `reason: '...'` where the event has `reason: "..."`. Found closing 7n5e4nkf, whose event had to be reformatted by hand before the commit could pass `scripts/check-commit.sh`.

## Done when
- ledger writes every event so that `biome check` reports nothing for it, including strings with double quotes, single quotes and both.
- A test covers those strings.
- The PR that does this closes the issue in the same change, with a reason saying how each condition was met.
