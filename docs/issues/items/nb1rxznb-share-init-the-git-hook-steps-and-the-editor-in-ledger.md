# Share init, the git hook steps and the editor in ledger

## Goal
Move `init`'s steps, the git hook steps and the CLI editor, which adr and issues implement the same way, into ledger. Each tool keeps its starter config, templates, skill text and its own `commit-msg` extras.

## Notes
Candidate 6 of ?29's comparison.

- `initDecisionLog` (`packages/adr/src/init.ts:105`) and `initIssueLog` (`packages/issues/src/init.ts:114`) share the config placement, the templates, the skill and AGENTS.md pointer with their rollback, and the commit. `appendLine`, `namesSkill` and `agentsPointer` are copies.
- From `packages/adr/src/hooks.ts` and `packages/issues/src/hooks.ts`: the hook commands, `registrations`, `shown`, `inHookOrder`, `result`, install, uninstall and print, `stagingSafe`, and `runPreCommitHook` (adr 192, issues 250) are the same apart from names. So is the shared part of `addHookTrailers`: skip on an existing event trailer or during a merge, then append the staged event trailers. Both `cli/hooks.ts` files differ only in names and option help: issues gives `--manager` a `value` and a `help` string (`packages/issues/src/cli/hooks.ts:39-45`), and adr doesn't. Option help becomes a parameter of the shared `hooksCommand`, so each tool's `--help` text stays as it is.
- `packages/issues/src/cli/editor.ts` is a copy of adr's. Its header names it a step 5 candidate. adr's failure message adds "; the draft is staged as rendered"; make that a parameter.
- Init's index step: `7zzt1n0x` makes `issues init` render the tree its commit holds and refresh afterwards, as `adr init` does. This lift waits for it, so the two init index steps are the same by then and the lift changes no behavior.
- issues removes an empty `<root>/.gitkeep` placeholder (?8), and adr doesn't. Keep that as an option only issues turns on.
- Domain stays in the tools: starter config text, built-in templates, skill text, and issues' "fixes ?N" and current-issue notes in `commit-msg`.
- Proposed API and placement:
  - In `packages/ledger/src/surfaces/`, exported from the root entry: `initToolLog(log, { tool, configName, starterConfig, builtins, defaultTemplates, skill, index, commitTitles, removePlaceholder })`, `runPreCommitHook({ worktree, index, env, followRenames, renderIndex, verify, tool })` and `stagedEventTrailers(git, layout, keys): Promise<{ refs: EventRef[]; trailers: Trailer[] }>`. It returns the refs as well, because issues' `commit-msg` builds its "fixes ?N" set from them (`closing`, `packages/issues/src/hooks.ts:204`). issues' `addHookTrailers` runs inside `withGitOperation` (`packages/issues/src/hooks.ts:165`) and adr's doesn't (`packages/adr/src/hooks.ts:139-166`), an accidental difference; the shared step runs inside it, which only groups its git calls into one operation and changes no output. They take a `ToolLog` and call `resolveAttribution` (`surfaces/actor.ts`), so they can't go in `hooks/`. `stagedEventTrailers` is built on `stagedEventRefs` in `surfaces/commit-message.ts` (`adr/src/write.ts:1832`, `issues/src/apply.ts:438`) and defines no copy. The write-path lift needs `stagedEventRefs` too; this issue doesn't wait for it: whichever of the two lands first moves `stagedEventRefs` there, and the other uses it.
  - `addHookTrailers` (`adr/src/hooks.ts:139-170`) today takes the staged paths in `git diff --cached` order, without filtering `.yaml` or deduping. `stagedEventRefs` sorts, filters and dedupes, and `eventTrailers` already dedupes by subject and type, so for ASCII paths the trailers don't change.
  - In `packages/ledger/src/hooks/`, exported from the root entry: `hookRegistrations`, next to `install.ts`.
  - In `packages/ledger/src/cli/`, exported from `ledger/cli` (`cli/index.ts`): `editorFromEnv` and a `hooksCommand`.
- Document the new exports in `packages/ledger/README.md`.

## Done when
- ledger exports the init steps, the pre-commit and commit-msg steps, hook registration, a `hooks` command and the editor, with unit tests.
- adr and issues use them, and none of the copies listed in the Notes remains in either tool.
- `adr init`, `issues init`, `adr hooks …`, `issues hooks …` and both editors behave as before: both tools' existing tests (adr's `src/init.test.ts`, `src/hooks.test.ts`, `src/cli/init.test.ts`, `src/cli/hooks.test.ts`, `src/cli/editor.test.ts`; issues' `src/init.test.ts`, `src/hooks.test.ts`, `src/cli/init.test.ts`, `src/cli/editor.test.ts`) pass with no change to what they assert.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
