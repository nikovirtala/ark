# Ask the installed git whether a -m message ends in trailers

## Summary
ledger decides whether a `-m` message ends in trailers with a copy of the rules in git's `trailer.c`. git 2.56 changed those rules ([d122e37 "trailers: stop recognizing URLs as trailers"](https://github.com/git/git/commit/d122e37976050ba91a5ababdb54ee328380e9a9b): a line starting with `https://` is no longer a trailer). ledger now disagrees with the user's git, and `ADR:`/`Issue:` trailers merged into such a paragraph aren't read as trailers. The Release run 40691600163 failed on it, so ledger 0.7.0, adr 0.5.0 and issues 0.2.0 weren't published.

## Steps to reproduce
1. Install git 2.56.0 (the ubuntu-26.04 runner image 20261025.179.1 has it).
2. Run `pnpm build && pnpm --filter @nikovirtala/ledger test`.
3. Or run `adr accept <id> --commit -m $'docs(adr): accept x\n\nhttps://example.com/x'`, then `git log -1 --format=%(trailers:only)`.

## Expected
ledger merges trailers into the last paragraph exactly when the installed git reads trailers in it, on any git version, so `%(trailers)` shows both the user's trailers and ledger's.

## Actual
In `git.test.ts`, `reads "s\n\nhttps://example.com/x" as a trailer block: true` gets false, and the property `agrees with git on generated last paragraphs` fails with seed 713487448 and counterexample `[["https://example.com/x"]]`. On git 2.56 the merged paragraph `https://example.com/x\nADR: k\nADR-Event: accepted` parses as no trailers. git 2.50.1 and 2.55.0 read the URL line as a trailer.

## Done when
- `Git.commit` and `commitWithRecovery` decide by calling the installed git (`git interpret-trailers --parse`), once, only for `-m` messages, and ledger has no copy of git's trailer rules left.
- ledger's, adr's and issues' tests pass on git 2.50 and 2.56, with a property test checking ledger's merge decision against the installed git.
- A patch changeset for ledger is in the PR.
- The PR closes this issue in the same change, with a reason.
