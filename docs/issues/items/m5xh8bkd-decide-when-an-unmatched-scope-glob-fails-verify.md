# Decide when an unmatched scope glob fails verify

## Goal
Decide, in issues PR 2, when a scope glob of an open issue that matches no tracked file is a `verify` failure, so an issue for planned work can name the code it will add. Rough edge 9 of PR #22.

## Notes
In 0.1.0, `issues scope 6930v8w9 --set "packages/issues/src/mcp/**"` only notes `issues: warning: packages/issues/src/mcp/** matches no tracked file` and exits 0, since 0.1.0 runs no checks over code. The "CI checks" table of `docs/02-issues-v1.md` lists "Scope globs: a scope glob of an open issue matches no tracked file" as a failure. ledger's `scopeGlobCheck` (`packages/ledger/src/scope/checks.ts`) reports `scope/glob-unmatched` as an error for subjects whose status is in the kind's `scope.activeIn`, and issues' kind already declares `activeIn: ["open", "in-progress"]` (`packages/issues/src/kind.ts`). So once PR 2 runs that check for issues, an issue scoped to code that doesn't exist yet fails `verify`. That is why issues PR 3's issue (`6930v8w9`) is scoped to existing files instead of `packages/issues/src/mcp/**`.

The options from PR #22: keep an unmatched glob a warning, or allow it until the issue is started (`in-progress`), when the code should start to exist. adr counts proposed decisions as active (`activeIn: ["proposed", "accepted"]`), so a proposed decision can't name planned code either; the design should say whether adr stays as it is.

## Done when
- The "CI checks" table of `docs/02-issues-v1.md` and the issues README state which issue states make an unmatched scope glob an error, and why.
- `issues verify` follows that rule, with tests for an open issue that isn't started and one in progress, each with a glob that matches no tracked file.
- `issues scope`'s note for an unmatched glob says when `verify` will report it, as adr's scope note does.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
