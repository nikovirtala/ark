# @nikovirtala/ledger

## 0.4.0

### Minor Changes

- a28dbe8: Add the Scope layer: a Node-independent glob dialect that matches dot-files (`parseGlob`,
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

## 0.3.0

### Minor Changes

- b241ce5: Add the domain-free half of a kind: `defineKind` with the state machine as data, the fold engine (`foldLog`, `projectLog`), numbering on first-parent main (`numberLog`), fold-aware verify checks (transitions, invariants, relations, template lint), atomic log writes (`writeEvents`, `writeNewFile`, `overlayTree`), surfaces (`openToolLog`, `resolveActor`, `resolveSubjectInput`, `renderStateHeader`), the `@nikovirtala/ledger/cli` entry (`runCli`, `verifyCommand`), and testing generators (`exampleMachineKind`, `arbLegalHistory`, `arbSemanticTamper`). Plain `KindSchema` kinds keep their step 2 checks.
  
  Behaviour change: `Git.commit` now writes `trailers` as a literal final paragraph of the message instead of passing them to `git commit --trailer`, so repeated keys and their order survive any `trailer.*` config. Don't put a trailer block of your own in `message`.

## 0.2.0

### Minor Changes

- 51f134c: Add the mechanical core: git access, subject and event identity, the `ledger/v1` envelope and its JSON Schema, log snapshots, mechanical verify checks with text, JSON and GitHub output, `[[sources]]`, section-schema templates, the shared git hook shim, and the `@nikovirtala/ledger/testing` harness. The API is internal and unstable until 1.0.

## 0.1.0

### Minor Changes

- 34e5d6e: First release: the `ENVELOPE_VERSION` constant and an empty `@nikovirtala/ledger/testing` entry. Published to prove the release pipeline; the API is internal and unstable.
