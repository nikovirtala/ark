---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": minor
"@nikovirtala/issues": minor
---

Add a `doctor` command that reports gaps in a repository's agent setup. `adr doctor` and `issues doctor` check every piece the matching `init --setup` writes against what the installed tool would write, and report each gap with the command that fixes it: a piece that is `missing`, `outdated` (written by an older version of the tool), `changed` by someone, or a `wrong-version` MCP pin that names a version other than the installed one. `doctor` exits 1 when any piece is missing, and 0 otherwise; an outdated, changed or wrong-version piece is reported but does not fail. `--fix-clone` also installs this clone's git hooks (what can never be wrong to install), reusing the shared hook-install step, and says why it could not when another tool owns the hooks path.

`@nikovirtala/ledger` adds `runDoctor`, `doctorCommand`, `pieceStates`, `setupPieces`, and the types `DoctorResult`, `DoctorSpec`, `Gap`, `GapKind` and `PieceState`. The check reuses the setup table and the ownership hashes in `ark-setup.lock`, so `doctor` and `init --setup` agree on what a complete setup is.
