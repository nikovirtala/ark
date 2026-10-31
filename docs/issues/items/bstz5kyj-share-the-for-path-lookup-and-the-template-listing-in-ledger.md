# Share the for-path lookup and the template listing in ledger

## Goal
Move the path handling and lookup behind `adr for` and `issues for`, and the template listing behind `adr_templates` and `issues_templates`, into ledger. Each tool keeps which subjects apply, their order and its document.

## Notes
Candidate 7 of ?29's comparison.

- `decisionsFor` and `repoPath` (`packages/adr/src/scope.ts:107, 89`), and `issuesFor` and `repoPath` (`packages/issues/src/scope.ts:83, 64`), share the path checks (length, outside the repository, directory by `lstat` or index listing, with the same messages but the tool's name), tracked detection, `scanAnchors` with `scopeLookup`, unresolved anchors and the findings filter.
- `listTemplates` (both tools' `templates/list.ts`) differs only in kind, format name and notes.
- Domain stays in the tools: which subjects apply (adr: decisions ever in force; issues: globs of open and in-progress issues, and anchors of those or, with `--all`, of every issue), the order, and the per-path fields.
- Search ranking is not part of this. fe1f412 kept ranking with each tool, and ?29 leaves it there.
- ?12 also touches `packages/ledger/src/scope/anchors.ts` (the anchor pattern's source part) and may run at the same time; whichever lands second rebases.
- Proposed API and placement:
  - In `packages/ledger/src/scope/`: `lookupPaths(git, { tool, tree, ref, commit, cwd, paths, keyword, exclude, excludeDirs, globSubjects, known })`, which returns `{ path, tracked, matches, unresolved }` per path. The two subject inputs are separate because the tools match globs against a filtered list but resolve anchors against every view: `globSubjects: { id, globs }[]` is what goes to `scopeLookup` (adr's views filtered by `GLOBS_APPLY`, `packages/adr/src/scope.ts:162`; issues' by `ACTIVE`, `packages/issues/src/scope.ts:135`), and `known(id: string): boolean` is the tool's `views.get(id) !== undefined` over all views. An anchor match with `source !== null` goes to `unresolved` with reason `other-log`, and one with `source === null` and `!known(id)` with reason `not-found`, as now (`adr/src/scope.ts:172-179`, `issues/src/scope.ts:146-153`). Each tool then filters the remaining matches (issues' `shown`, which keeps only active issues unless `--all`, `issues/src/scope.ts:139, 158`), orders them and maps them. Passing one list for both would either report anchors to closed issues or superseded decisions as `not-found`, or let globs of inactive subjects match.
  - In `packages/ledger/src/templates/`: `listKindTemplates(tree, root, { requireSections, builtins })`. It takes the required section ids instead of the kind, because `templates/` (layer 4) sits below `kind/` (layer 6). Each tool passes `kind.def.templates?.requireSections ?? []`, as its `lint` does now.
- Document the new exports in `packages/ledger/README.md`.

## Done when
- ledger exports the path lookup and the template listing, with unit tests.
- adr and issues use them, and no copy of `repoPath`, the directory checks or the template listing remains in either tool.
- `adr for`, `issues for`, `adr_templates` and `issues_templates` return the same text and documents as before: both tools' existing tests pass with no change to what they assert.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
