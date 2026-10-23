---
"@nikovirtala/ledger": minor
---

Add the Scope layer: a Node-independent glob dialect that matches dot-files (`parseGlob`,
`globMatcher`, `escapeGlob`), whole-set events with latest-wins folding and the
`--set`/`--add`/`--remove` helper (`setEventType`, `latestSet`, `applySetOp`), comment-anchor
scanning with a per-kind `scope.keyword` (resolved as `kind.anchorKeyword`; `scanAnchors`,
`anchorsInLine`), rename following (`stagedRenames`, `followRenames`) and the path-to-subjects
lookup (`scopeLookup`, `scopedSubjects`). Add commit messages from a one-line Conventional Commits
template that keeps the description within 72 characters (`readCommitTemplate`,
`parseCommitTemplate`, `renderCommitMessage`, `checkCommitMessage`, `wrapParagraph`,
`commitMessageText` and the `mergeTrailers` option of `Git.commit`), attribution with notes
(`resolveAttribution`, `parseOnBehalfOf`), `Git.committerIdentity()`, and in the `cli` entry
`COMMIT_OPTIONS`, `commitChoice` and the `confirm` prompt.

### Changed behaviour

- `slugify` drops apostrophes instead of turning them into dashes: "Keep ark's tools" now gives
  `keep-arks-tools`, not `keep-ark-s-tools`. Existing files keep their names, because tools find
  bodies by id.
- `resolveActor` reads `ARK_ON_BEHALF_OF`: with `ARK_AGENT` set, the agent acts on behalf of that
  address and no git identity is read; an address that isn't an email is a `ConfigError`. Without
  `ARK_ON_BEHALF_OF` it still uses the git identity's email.
- `defineKind` throws `KindDefinitionError` for an invalid `scope.keyword` and for a `scope.event`
  whose data has no `set` array; a definition with such a `scope.event` was accepted before and is
  now refused.
