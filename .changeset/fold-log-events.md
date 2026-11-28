---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": minor
"@nikovirtala/issues": minor
---

`init --setup` now marks the log's events `linguist-generated` in `.gitattributes` (`docs/adr/events/** linguist-generated=true` for adr, `docs/issues/events/** linguist-generated=true` for issues, at the log's configured root), so GitHub folds them in pull request diffs as it does generated code. Like the other setup pieces it is owned line by line (`gitattributes.adr`, `gitattributes.issues`) and recorded in `ark-setup.lock`: every other line in `.gitattributes` is left alone, a rerun updates a line that still matches what `init` wrote, a line someone changed is left with the `init --force <piece>` note, and `doctor` reports a missing one. It is written even when no harness is detected. `--no-gitattributes` skips it.
